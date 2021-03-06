/*global $*/
import Service, { inject as service } from '@ember/service';
import { get, set } from '@ember/object';

import { CACHE_CONTROL, CONTENT_TYPE } from 'consul-ui/utils/http/headers';

import { HEADERS_TOKEN as CONSUL_TOKEN } from 'consul-ui/utils/http/consul';

import { env } from 'consul-ui/env';
import getObjectPool from 'consul-ui/utils/get-object-pool';
import Request from 'consul-ui/utils/http/request';
import createURL from 'consul-ui/utils/createURL';

// reopen EventSources if a user changes tab
export const restartWhenAvailable = function(client) {
  return function(e) {
    // setup the aborted connection restarting
    // this should happen here to avoid cache deletion
    const status = get(e, 'errors.firstObject.status');
    if (status === '0') {
      // Any '0' errors (abort) should possibly try again, depending upon the circumstances
      // whenAvailable returns a Promise that resolves when the client is available
      // again
      return client.whenAvailable(e);
    }
    throw e;
  };
};
class HTTPError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
const dispose = function(request) {
  if (request.headers()[CONTENT_TYPE.toLowerCase()] === 'text/event-stream') {
    const xhr = request.connection();
    // unsent and opened get aborted
    // headers and loading means wait for it
    // to finish for the moment
    if (xhr.readyState) {
      switch (xhr.readyState) {
        case 0:
        case 1:
          xhr.abort();
          break;
      }
    }
  }
  return request;
};
// TODO: Potentially url should check if any of the params
// passed to it are undefined (null is fine). We could then get rid of the
// multitude of checks we do throughout the adapters
// right now createURL converts undefined to '' so we need to check thats not needed
// anywhere (todo written here for visibility)
const url = createURL(encodeURIComponent);
const createHeaders = function(lines) {
  return lines.reduce(function(prev, item) {
    const temp = item.split(':');
    if (temp.length > 1) {
      prev[temp[0].trim()] = temp[1].trim();
    }
    return prev;
  }, {});
};
export default Service.extend({
  dom: service('dom'),
  settings: service('settings'),
  init: function() {
    this._super(...arguments);
    this._listeners = this.dom.listeners();
    const maxConnections = env('CONSUL_HTTP_MAX_CONNECTIONS');
    set(this, 'connections', getObjectPool(dispose, maxConnections));
    if (typeof maxConnections !== 'undefined') {
      set(this, 'maxConnections', maxConnections);
      // when the user hides the tab, abort all connections
      this._listeners.add(this.dom.document(), {
        visibilitychange: e => {
          if (e.target.hidden) {
            this.connections.purge();
          }
        },
      });
    }
  },
  willDestroy: function() {
    this._listeners.remove();
    this.connections.purge();
    set(this, 'connections', undefined);
    this._super(...arguments);
  },
  url: function() {
    return url(...arguments);
  },
  body: function(strs, ...values) {
    let body = {};
    const doubleBreak = strs.reduce(function(prev, item, i) {
      // Ensure each line has no whitespace either end, including empty lines
      item = item
        .split('\n')
        .map(item => item.trim())
        .join('\n');
      if (item.indexOf('\n\n') !== -1) {
        return i;
      }
      return prev;
    }, -1);
    if (doubleBreak !== -1) {
      // This merges request bodies together, so you can specify multiple bodies
      // in the request and it will merge them together.
      // Turns out we never actually do this, so it might be worth removing as it complicates
      // matters slightly as we assumed post bodies would be an object.
      // This actually works as it just uses the value of the first object, if its an array
      // it concats
      body = values.splice(doubleBreak).reduce(function(prev, item, i) {
        switch (true) {
          case Array.isArray(item):
            if (i === 0) {
              prev = [];
            }
            return prev.concat(item);
          case typeof item !== 'string':
            return {
              ...prev,
              ...item,
            };
          default:
            return item;
        }
      }, body);
    }
    return [body, ...values];
  },
  request: function(cb) {
    const client = this;
    return cb(function(strs, ...values) {
      // first go to the end and remove/parse the http body
      const [body, ...urlVars] = client.body(...arguments);
      // with whats left get the method off the front
      const [method, ...urlParts] = client.url(strs, ...urlVars).split(' ');
      // with whats left use the rest of the line for the url
      // with whats left after the line, use for the headers
      const [url, ...headerParts] = urlParts.join(' ').split('\n');

      return client.settings.findBySlug('token').then(function(token) {
        const requestHeaders = createHeaders(headerParts);
        const headers = {
          // default to application/json
          ...{
            [CONTENT_TYPE]: 'application/json; charset=utf-8',
          },
          // add any application level headers
          ...{
            [CONSUL_TOKEN]: typeof token.SecretID === 'undefined' ? '' : token.SecretID,
          },
          // but overwrite or add to those from anything in the specific request
          ...requestHeaders,
        };
        // We use cache-control in the response
        // but we don't want to send it, but we artificially
        // tag it onto the response below if it is set on the request
        delete headers[CACHE_CONTROL];

        return new Promise(function(resolve, reject) {
          const options = {
            url: url.trim(),
            method: method,
            contentType: headers[CONTENT_TYPE],
            // type: 'json',
            complete: function(xhr, textStatus) {
              client.complete(this.id);
            },
            success: function(response, status, xhr) {
              const headers = createHeaders(xhr.getAllResponseHeaders().split('\n'));
              if (typeof requestHeaders[CACHE_CONTROL] !== 'undefined') {
                // if cache-control was on the request, artificially tag
                // it back onto the response, also see comment above
                headers[CACHE_CONTROL] = requestHeaders[CACHE_CONTROL];
              }
              const respond = function(cb) {
                return cb(headers, response);
              };
              // TODO: nextTick ?
              resolve(respond);
            },
            error: function(xhr, textStatus, err) {
              let error;
              if (err instanceof Error) {
                error = err;
              } else {
                let status = xhr.status;
                // TODO: Not sure if we actually need this, but ember-data checks it
                if (textStatus === 'abort') {
                  status = 0;
                }
                if (textStatus === 'timeout') {
                  status = 408;
                }
                error = new HTTPError(status, xhr.responseText);
              }
              //TODO: nextTick ?
              reject(error);
            },
            converters: {
              'text json': function(response) {
                try {
                  return $.parseJSON(response);
                } catch (e) {
                  return response;
                }
              },
            },
          };
          if (typeof body !== 'undefined') {
            // Only read add HTTP body if we aren't GET
            // Right now we do this to avoid having to put data in the templates
            // for write-like actions
            // potentially we should change things so you _have_ to do that
            // as doing it this way is a little magical
            if (method !== 'GET' && headers[CONTENT_TYPE].indexOf('json') !== -1) {
              options.data = JSON.stringify(body);
            } else {
              // TODO: Does this need urlencoding? Assuming jQuery does this
              options.data = body;
            }
          }
          // temporarily reset the headers/content-type so it works the same
          // as previously, should be able to remove this once the data layer
          // rewrite is over and we can assert sending via form-encoded is fine
          // also see adapters/kv content-types in requestForCreate/UpdateRecord
          // also see https://github.com/hashicorp/consul/issues/3804
          options.contentType = 'application/json; charset=utf-8';
          headers[CONTENT_TYPE] = options.contentType;
          //
          options.beforeSend = function(xhr) {
            if (headers) {
              Object.keys(headers).forEach(key => xhr.setRequestHeader(key, headers[key]));
            }
            this.id = client.acquire(options, xhr);
          };
          return $.ajax(options);
        });
      });
    });
  },
  abort: function(id = null) {
    this.connections.purge();
  },
  whenAvailable: function(e) {
    // if we are using a connection limited protocol and the user has hidden the tab (hidden browser/tab switch)
    // any aborted errors should restart
    const doc = this.dom.document();
    if (typeof this.maxConnections !== 'undefined' && doc.hidden) {
      return new Promise(resolve => {
        const remove = this._listeners.add(doc, {
          visibilitychange: function(event) {
            remove();
            // we resolve with the event that comes from
            // whenAvailable not visibilitychange
            resolve(e);
          },
        });
      });
    }
    return Promise.resolve(e);
  },
  acquire: function(options, xhr) {
    const request = new Request(options.method, options.url, { body: options.data || {} }, xhr);
    return this.connections.acquire(request, request.getId());
  },
  complete: function() {
    return this.connections.release(...arguments);
  },
});

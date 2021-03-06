import { ApolloLink, Observable, fromError } from 'apollo-link';
import {
  serializeFetchParameter,
  selectURI,
  selectHttpOptionsAndBody,
  fallbackHttpConfig,
  Body,
  HttpOptions,
  UriFunction as _UriFunction,
} from 'apollo-link-http-common';
import { DefinitionNode } from 'graphql';
import '@capacitor-community/http';
import { Plugins } from '@capacitor/core';

const { Http } = Plugins;

export type ClientAwarenessHeaders = {
  [key: string]: string;
};
export interface UriFunction extends _UriFunction {}
export interface Options extends HttpOptions {
  /**
   * If set to true, use the HTTP GET method for query operations. Mutations
   * will still use the method specified in fetchOptions.method (which defaults
   * to POST).
   */
  useGETForQueries?: boolean;
}

export const createHttpLink = (linkOptions: Options = {}) => {
  let {
    uri = '/graphql',
    includeExtensions,
    useGETForQueries,
    ...requestOptions
  } = linkOptions;

  const linkConfig = {
    http: { includeExtensions },
    options: requestOptions.fetchOptions,
    credentials: requestOptions.credentials,
    headers: requestOptions.headers,
  };

  return new ApolloLink(operation => {
    let chosenURI = selectURI(operation, uri);

    const context = operation.getContext();

    const clientAwarenessHeaders: ClientAwarenessHeaders = {};
    if (context.clientAwareness) {
      const { name, version } = context.clientAwareness;
      if (name) {
        clientAwarenessHeaders['apollographql-client-name'] = name;
      }
      if (version) {
        clientAwarenessHeaders['apollographql-client-version'] = version;
      }
    }

    const contextHeaders = { ...clientAwarenessHeaders, ...context.headers };

    const contextConfig = {
      http: context.http,
      options: context.fetchOptions,
      credentials: context.credentials,
      headers: contextHeaders,
    };

    const { options, body } = selectHttpOptionsAndBody(
      operation,
      fallbackHttpConfig,
      linkConfig,
      contextConfig
    );

    const definitionIsMutation = (d: DefinitionNode) => {
      return d.kind === 'OperationDefinition' && d.operation === 'mutation';
    };
    if (
      useGETForQueries &&
      !operation.query.definitions.some(definitionIsMutation)
    ) {
      options.method = 'GET';
    }

    if (options.method === 'GET') {
      const { newURI, parseError } = rewriteURIForGET(chosenURI, body);
      if (parseError) {
        return fromError(parseError);
      }
      chosenURI = newURI;
    } else {
      try {
        (options as any).body = body;
      } catch (parseError) {
        return fromError(parseError);
      }
    }

    return new Observable(observer => {
      Http.request({
        url: chosenURI,
        method: options.method,
        data: options.body,
        headers: {
          ...options.headers,
          'Content-Type': 'application/json',
        },
      })
        .then(result => {
          observer.next(result.data);
          observer.complete();
          return result;
        })

        .catch(err => {
          if (err.name === 'AbortError') return;
          if (err.result && err.result.errors && err.result.data) {
            observer.next(err.result);
          }
          observer.error(err);
        });

      return () => {};
    });
  });
};

// For GET operations, returns the given URI rewritten with parameters, or a
// parse error.
function rewriteURIForGET(chosenURI: string, body: Body) {
  // Implement the standard HTTP GET serialization, plus 'extensions'. Note
  // the extra level of JSON serialization!
  const queryParams: any = [];
  const addQueryParam = (key: string, value: string) => {
    queryParams.push(`${key}=${encodeURIComponent(value)}`);
  };

  if ('query' in body) {
    addQueryParam('query', body.query!);
  }
  if (body.operationName) {
    addQueryParam('operationName', body.operationName);
  }
  if (body.variables) {
    let serializedVariables;
    try {
      serializedVariables = serializeFetchParameter(
        body.variables,
        'Variables map'
      );
    } catch (parseError) {
      return { parseError };
    }
    addQueryParam('variables', serializedVariables);
  }
  if (body.extensions) {
    let serializedExtensions;
    try {
      serializedExtensions = serializeFetchParameter(
        body.extensions,
        'Extensions map'
      );
    } catch (parseError) {
      return { parseError };
    }
    addQueryParam('extensions', serializedExtensions);
  }

  // Reconstruct the URI with added query params.
  // XXX This assumes that the URI is well-formed and that it doesn't
  //     already contain any of these query params. We could instead use the
  //     URL API and take a polyfill (whatwg-url@6) for older browsers that
  //     don't support URLSearchParams. Note that some browsers (and
  //     versions of whatwg-url) support URL but not URLSearchParams!
  let fragment = '',
    preFragment = chosenURI;
  const fragmentStart = chosenURI.indexOf('#');
  if (fragmentStart !== -1) {
    fragment = chosenURI.substr(fragmentStart);
    preFragment = chosenURI.substr(0, fragmentStart);
  }
  const queryParamsPrefix = preFragment.indexOf('?') === -1 ? '?' : '&';
  const newURI =
    preFragment + queryParamsPrefix + queryParams.join('&') + fragment;
  return { newURI };
}

export class CapacitorHttpLink extends ApolloLink {
  constructor(opts?: Options) {
    super(createHttpLink(opts).request);
  }
}

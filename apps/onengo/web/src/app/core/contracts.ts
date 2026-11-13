import type { HttpLike } from './http/http';

/**
 * The request and response interfaces the server validates, shared with the
 * server. Only types cross over (`import type`), so nothing from outside web/
 * reaches the bundle; the web architecture test keeps it that way.
 */
export type * from '@onengo/platform/contracts';

/**
 * A route the server checks with a fixed contract, as `'<METHOD> <path>'`
 * with `:name` parameters exactly as the server registers it. `body` is the
 * contract request; `answer` is the contract response where the server has
 * one, otherwise what the web reads from it.
 */
export interface ContractRoute {
  body?: unknown;
  answer: unknown;
}

type ParamNames<P extends string> = P extends `${string}:${infer K}/${infer Rest}` ? K | ParamNames<Rest> : P extends `${string}:${infer K}` ? K : never;
type ParamArg<R extends string> = [ParamNames<R>] extends [never] ? [] : [params: Record<ParamNames<R>, string>];
type BodyArg<C> = C extends { body: infer B } ? [body: B] : [];

/**
 * Calls a gateway's contracted routes: the address comes from the route's
 * pattern with its parameters encoded, the body must match the route's request
 * and the answer has the route's type, so a gateway names no type per call.
 *
 * ```ts
 * const send = contracted<{ 'PUT /api/admin/roles/:key': { body: UpdateRoleRequest; answer: RoleView } }>(http);
 * send('PUT /api/admin/roles/:key', { key }, { label });
 * ```
 */
export function contracted<T extends { [R in keyof T]: ContractRoute }>(http: HttpLike) {
  return <R extends keyof T & string>(route: R, ...args: [...ParamArg<R>, ...BodyArg<T[R]>]): Promise<T[R]['answer']> => {
    const space = route.indexOf(' ');
    const method = route.slice(0, space);
    const pattern = route.slice(space + 1);
    const named = pattern.includes('/:');
    const params = (named ? args[0] : {}) as Record<string, string>;
    const body: unknown = named ? args[1] : args[0];
    const url = pattern.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ''));
    switch (method) {
      case 'GET':
        return http.get(url);
      case 'POST':
        return body === undefined ? http.post(url) : http.post(url, body);
      case 'PUT':
        return http.put(url, body);
      case 'PATCH':
        return http.patch(url, body);
      case 'DELETE':
        return http.delete(url);
      default:
        throw new Error(`Unknown method in route ${route}`);
    }
  };
}

import type { DefinitionRoutes } from '../builder/http-builder';
import { contracted } from '../contracts';
import type { HttpLike } from './http';
import type { BuilderDetail, PageDef } from '../models';
import type { Pin, PagesGateway } from '../pages';
import { httpAggregate } from '../records/gateway/http-gateway';

const PINS = '/api/me/pins';
const HOME = '/api/builder/definitions/page/home';
const pin = (id: string) => `${PINS}/${encodeURIComponent(id)}`;

/** Pages and pins over HTTP: aggregates, the person's pins, and the Home page draft. */
export function httpPages(http: HttpLike): PagesGateway {
  const send = contracted<DefinitionRoutes>(http);
  return {
    aggregate: httpAggregate(http),
    pins: () => http.get<Pin[]>(PINS),
    addPin: (input) => http.post<Pin>(PINS, input),
    renamePin: (id, label) => http.patch<Pin>(pin(id), { label }),
    orderPins: (ids) => http.put<Pin[]>(`${PINS}/order`, { ids }),
    removePin: (id) => http.delete<void>(pin(id)),
    homePage: async () => {
      try {
        const d = await http.get<BuilderDetail>(HOME);
        return (d.draft?.body ?? d.published?.body ?? null) as PageDef | null;
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code === 'not_found') return null;
        throw e;
      }
    },
    saveHomeDraft: async (body) => {
      await send('PUT /api/builder/definitions/:kind/:key/draft', { kind: 'page', key: 'home' }, body);
    },
  };
}

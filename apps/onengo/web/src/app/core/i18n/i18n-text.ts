// Written by apps/onengo/web/scripts/locale-areas.mjs from the shared product locale files.

/** Screen text that loads with its screens: `core` with the shell and sign-in, each other area with its routes. */
export type TextArea = 'core' | 'admin' | 'builder' | 'import';

export const TEXT_FILES: Record<TextArea, Partial<Record<string, () => Promise<{ default: unknown }>>>> = {
  core: {
    en: () => import('@onengo/product/locale/en.json'),
    hi: () => import('@onengo/product/locale/hi.json'),
    ta: () => import('@onengo/product/locale/ta.json'),
    te: () => import('@onengo/product/locale/te.json'),
    bn: () => import('@onengo/product/locale/bn.json'),
    mr: () => import('@onengo/product/locale/mr.json'),
  },
  admin: {
    en: () => import('@onengo/product/locale/en.admin.json'),
    hi: () => import('@onengo/product/locale/hi.admin.json'),
    ta: () => import('@onengo/product/locale/ta.admin.json'),
    te: () => import('@onengo/product/locale/te.admin.json'),
    bn: () => import('@onengo/product/locale/bn.admin.json'),
    mr: () => import('@onengo/product/locale/mr.admin.json'),
  },
  builder: {
    en: () => import('@onengo/product/locale/en.builder.json'),
    hi: () => import('@onengo/product/locale/hi.builder.json'),
    ta: () => import('@onengo/product/locale/ta.builder.json'),
    te: () => import('@onengo/product/locale/te.builder.json'),
    bn: () => import('@onengo/product/locale/bn.builder.json'),
    mr: () => import('@onengo/product/locale/mr.builder.json'),
  },
  import: {
    en: () => import('@onengo/product/locale/en.import.json'),
    hi: () => import('@onengo/product/locale/hi.import.json'),
    ta: () => import('@onengo/product/locale/ta.import.json'),
    te: () => import('@onengo/product/locale/te.import.json'),
    bn: () => import('@onengo/product/locale/bn.import.json'),
    mr: () => import('@onengo/product/locale/mr.import.json'),
  },
};

/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

/// <reference types="vite/client" />

// Vite serves an .svg import as a URL; BrandMark relies on it.
declare module "*.svg" {
  const src: string;
  export default src;
}

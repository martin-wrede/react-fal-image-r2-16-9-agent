import { onRequest as __ai_js_onRequest } from "D:\\Documents\\CODING\\JAVASCRIPT\\react-image-video-test\\functions\\ai.js"
import { onRequest as __ai_copy_js_onRequest } from "D:\\Documents\\CODING\\JAVASCRIPT\\react-image-video-test\\functions\\ai copy.js"
import { onRequest as __ai_copy_2_js_onRequest } from "D:\\Documents\\CODING\\JAVASCRIPT\\react-image-video-test\\functions\\ai copy 2.js"
import { onRequest as __ai_copy_3_js_onRequest } from "D:\\Documents\\CODING\\JAVASCRIPT\\react-image-video-test\\functions\\ai copy 3.js"
import { onRequest as __ai_copy_4_js_onRequest } from "D:\\Documents\\CODING\\JAVASCRIPT\\react-image-video-test\\functions\\ai copy 4.js"

export const routes = [
    {
      routePath: "/ai",
      mountPath: "/",
      method: "",
      middlewares: [],
      modules: [__ai_js_onRequest],
    },
  {
      routePath: "/ai copy",
      mountPath: "/",
      method: "",
      middlewares: [],
      modules: [__ai_copy_js_onRequest],
    },
  {
      routePath: "/ai copy 2",
      mountPath: "/",
      method: "",
      middlewares: [],
      modules: [__ai_copy_2_js_onRequest],
    },
  {
      routePath: "/ai copy 3",
      mountPath: "/",
      method: "",
      middlewares: [],
      modules: [__ai_copy_3_js_onRequest],
    },
  {
      routePath: "/ai copy 4",
      mountPath: "/",
      method: "",
      middlewares: [],
      modules: [__ai_copy_4_js_onRequest],
    },
  ]
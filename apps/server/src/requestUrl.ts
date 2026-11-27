import { extractVirtualEnvironmentBasePath } from "@t3tools/shared/environmentPath";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

export const T3_FORWARDED_PREFIX_HEADER = "x-t3-forwarded-prefix";
const SAFE_HOST_HEADER = /^[A-Za-z0-9.\-[\]:]+$/;

/**
 * `HttpServerRequest.toURL` that honors `X-Forwarded-Proto: https` and virtual
 * environment mount prefixes (`/_env/<environmentId>`) for OAuth, DPoP, and pairing URLs.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> =>
  HttpServerRequest.toURL(
    request.headers["x-forwarded-proto"] === "https" && request.protocol !== "https"
      ? request.modify({ protocol: "https" })
      : request,
  ).pipe(
    Option.map((url) => {
      const prefixHeader = request.headers[T3_FORWARDED_PREFIX_HEADER];
      const prefix =
        typeof prefixHeader === "string"
          ? extractVirtualEnvironmentBasePath(prefixHeader.trim())
          : "";
      if (prefix !== "") {
        const forwardedHost = request.headers["x-forwarded-host"];
        if (typeof forwardedHost === "string" && SAFE_HOST_HEADER.test(forwardedHost.trim())) {
          url.host = forwardedHost.trim();
        }
        if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
          url.pathname = `${prefix}${url.pathname.startsWith("/") ? url.pathname : `/${url.pathname}`}`;
        }
      }
      return url;
    }),
  );

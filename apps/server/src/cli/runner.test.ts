// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { isBlockedPrivateAddress, startSsrfSafeHttpProxyServer } from "./runner.ts";

describe("runner SSRF protection", () => {
  it("blocks private, loopback, CGNAT, metadata, and link-local IPv4/IPv6 ranges", () => {
    assert.isTrue(isBlockedPrivateAddress("127.0.0.1"));
    assert.isTrue(isBlockedPrivateAddress("10.1.2.3"));
    assert.isTrue(isBlockedPrivateAddress("172.16.0.1"));
    assert.isTrue(isBlockedPrivateAddress("172.31.255.254"));
    assert.isTrue(isBlockedPrivateAddress("192.168.1.1"));
    assert.isTrue(isBlockedPrivateAddress("169.254.169.254"));
    assert.isTrue(isBlockedPrivateAddress("100.64.0.5"));
    assert.isTrue(isBlockedPrivateAddress("0.0.0.0"));
    assert.isTrue(isBlockedPrivateAddress("::1"));
    assert.isTrue(isBlockedPrivateAddress("fe80::1%en0"));
    assert.isTrue(isBlockedPrivateAddress("fd00::1"));
    assert.isTrue(isBlockedPrivateAddress("::ffff:169.254.169.254"));

    assert.isFalse(isBlockedPrivateAddress("1.1.1.1"));
    assert.isFalse(isBlockedPrivateAddress("8.8.8.8"));
    assert.isFalse(isBlockedPrivateAddress("172.32.0.1"));
    assert.isFalse(isBlockedPrivateAddress("2606:4700:4700::1111"));
  });

  it("rejects CONNECT requests to loopback / private destinations", async () => {
    const proxy = await startSsrfSafeHttpProxyServer("127.0.0.1", 0);
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const sock = NodeNet.connect({ host: "127.0.0.1", port: proxy.port }, () => {
          sock.write("CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254:80\r\n\r\n");
        });
        const chunks: Array<Buffer> = [];
        sock.on("data", (chunk) => chunks.push(chunk));
        sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        sock.on("error", reject);
      });
      assert.include(response, "403 Forbidden");

      const httpStatus = await new Promise<number>((resolve, reject) => {
        const req = NodeHttp.request(
          {
            host: "127.0.0.1",
            port: proxy.port,
            path: "http://127.0.0.1:80/secret",
            method: "GET",
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.strictEqual(httpStatus, 403);
    } finally {
      await proxy.close();
    }
  });
});

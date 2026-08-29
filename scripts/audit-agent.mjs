#!/usr/bin/env node

/**
 * SIT ORBIT live-audit CLI.
 *
 * The audit build of the extension is the only component that can see OAuth
 * or SCombZ state.  This process is a deliberately small WebSocket server:
 * it receives redacted transcript events and sends natural-language commands
 * only.  It never receives a bearer token, cookie, CSRF value, tab id, or
 * private tool payload.
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_WAIT_MS = 30_000;

function usage() {
  console.log(`使い方:
  pnpm audit:agent -- preflight
  pnpm audit:agent -- sources
  pnpm audit:agent -- chat --message "今学期の授業を教えて" [--conversation ID] [--source-ref REF]
  pnpm audit:agent -- run scenario.json [--source-ref REF]

監査buildを先に読み込んだChrome拡張がlocalhostへ接続している必要があります。
`);
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item?.startsWith("--")) continue;
    const key = item.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, "true");
    }
  }
  return { command, options };
}

async function loadConfig() {
  const configPath = resolve(
    fileURLToPath(new URL("..", import.meta.url)),
    "apps/extension/dist/audit-bridge.json",
  );
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (
      parsed?.version !== "v1" ||
      !Number.isInteger(parsed.port) ||
      parsed.port < 1024 ||
      parsed.port > 65535 ||
      typeof parsed.secret !== "string" ||
      parsed.secret.length < 32
    ) {
      throw new Error("監査build設定が不正です。");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `apps/extension/dist/audit-bridge.json を読めません。先に pnpm --filter @sit-orbit/extension build:audit を実行してください。（${error instanceof Error ? error.message : "unknown"}）`,
    );
  }
}

function hmac(secret, value) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function encodeFrame(text) {
  const body = Buffer.from(text, "utf8");
  if (body.length > MAX_FRAME_BYTES)
    throw new Error("監査frameが大きすぎます。");
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  }
  if (body.length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function encodeControl(opcode, payload = Buffer.alloc(0)) {
  if (payload.length > 125) throw new Error("control frame is too large");
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const longLength = buffer.readBigUInt64BE(offset + 2);
      if (longLength > BigInt(MAX_FRAME_BYTES))
        throw new Error("frame too large");
      length = Number(longLength);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const total = headerLength + maskLength + length;
    if (buffer.length - offset < total) break;
    let payload = buffer.subarray(
      offset + headerLength + maskLength,
      offset + total,
    );
    if (masked) {
      const mask = buffer.subarray(
        offset + headerLength,
        offset + headerLength + 4,
      );
      const copy = Buffer.from(payload);
      for (let index = 0; index < copy.length; index += 1) {
        copy[index] ^= mask[index % 4];
      }
      payload = copy;
    }
    frames.push({ opcode, payload });
    offset += total;
  }
  return { frames, remainder: buffer.subarray(offset) };
}

function json(value) {
  return JSON.stringify(value);
}

function randomId(prefix) {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

function isAllowedOrigin(origin) {
  return !origin || origin.startsWith("chrome-extension://");
}

function makeServer(config) {
  const httpServer = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  let connection = null;
  let resolveConnection;
  const connectionPromise = new Promise((resolve) => {
    resolveConnection = resolve;
  });

  httpServer.on("upgrade", (request, socket) => {
    if (request.url !== "/" || !isAllowedOrigin(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (connection) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buffer = Buffer.alloc(0);
    let state = "hello";
    let nonce = "";
    let challenge = "";
    let inboundSequence = -1;
    let outboundSequence = 0;
    const pending = new Map();
    const send = (frame) => {
      const payload = Buffer.from(json(frame), "utf8");
      if (payload.length > MAX_FRAME_BYTES) throw new Error("frame too large");
      socket.write(encodeFrame(payload.toString("utf8")));
    };
    const close = () => {
      try {
        socket.write(encodeControl(0x8));
      } catch {
        // ignore close races
      }
      socket.destroy();
      if (connection?.socket === socket) connection = null;
    };
    const onFrame = (frame) => {
      if (frame.opcode === 0x8) {
        close();
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeControl(0xa, frame.payload));
        return;
      }
      if (frame.opcode !== 0x1) {
        close();
        return;
      }
      let message;
      try {
        message = JSON.parse(frame.payload.toString("utf8"));
      } catch {
        close();
        return;
      }
      if (state === "hello") {
        if (
          message?.type !== "hello" ||
          message.protocol_version !== PROTOCOL_VERSION ||
          typeof message.nonce !== "string" ||
          message.nonce.length < 16
        ) {
          close();
          return;
        }
        nonce = message.nonce;
        challenge = randomBytes(24).toString("base64url");
        state = "auth";
        send({
          type: "challenge",
          protocol_version: PROTOCOL_VERSION,
          nonce,
          challenge,
        });
        return;
      }
      if (state === "auth") {
        const expected = hmac(
          config.secret,
          `${PROTOCOL_VERSION}|${nonce}|${challenge}|extension`,
        );
        if (
          message?.type !== "auth" ||
          message.protocol_version !== PROTOCOL_VERSION ||
          message.nonce !== nonce ||
          message.challenge !== challenge ||
          typeof message.proof !== "string" ||
          !sameSecret(message.proof, expected)
        ) {
          close();
          return;
        }
        state = "ready";
        send({
          type: "ready",
          protocol_version: PROTOCOL_VERSION,
          proof: hmac(
            config.secret,
            `${PROTOCOL_VERSION}|${nonce}|${challenge}|cli`,
          ),
        });
        connection = {
          socket,
          sendCommand(command) {
            const requestId = command.request_id;
            return new Promise((resolve, reject) => {
              pending.set(requestId, { resolve, reject });
              send({
                type: "command",
                sequence: outboundSequence++,
                command,
              });
            });
          },
          close,
        };
        resolveConnection(connection);
        return;
      }
      if (state !== "ready") {
        close();
        return;
      }
      if (message?.type !== "response" && message?.type !== "progress") {
        if (message?.type !== "keepalive") {
          close();
          return;
        }
      }
      if (
        !Number.isSafeInteger(message.sequence) ||
        message.sequence <= inboundSequence
      ) {
        close();
        return;
      }
      inboundSequence = message.sequence;
      if (message.type === "keepalive") return;
      if (message.type === "progress") {
        console.error(
          JSON.stringify({
            event: "progress",
            request_id: message.request_id,
            phase: message.phase,
            detail: message.detail,
          }),
        );
        return;
      }
      const item = pending.get(message.request_id);
      if (!item) return;
      pending.delete(message.request_id);
      if (message.ok) item.resolve(message.payload);
      else
        item.reject(new Error(message.error || "監査コマンドに失敗しました。"));
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const decoded = decodeFrames(buffer);
        buffer = decoded.remainder;
        for (const frame of decoded.frames) onFrame(frame);
      } catch {
        close();
      }
    });
    socket.on("close", () => {
      for (const item of pending.values())
        item.reject(new Error("監査bridgeが切断されました。"));
      pending.clear();
      if (connection?.socket === socket) connection = null;
    });
    socket.on("error", () => close());
  });
  return {
    httpServer,
    async waitForConnection(waitMs) {
      if (connection) return connection;
      return Promise.race([
        connectionPromise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("監査buildの拡張が接続しませんでした。")),
            waitMs,
          ),
        ),
      ]);
    },
  };
}

async function sendCommand(connection, type, payload = {}) {
  return connection.sendCommand({
    type,
    request_id: randomId("audit"),
    ...payload,
  });
}

function printResult(command, payload) {
  console.log(JSON.stringify({ command, result: payload }, null, 2));
}

function printBlocked(command, reason, details = {}) {
  console.log(
    JSON.stringify(
      {
        status: "BLOCKED",
        command,
        reason,
        ...details,
      },
      null,
      2,
    ),
  );
}

function isKnownPreflight(payload) {
  return Boolean(payload && payload.status === "known");
}

async function run() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "help" || command === "--help") {
    usage();
    return;
  }
  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    console.error(JSON.stringify({ status: "BLOCKED", reason: error.message }));
    process.exitCode = 2;
    return;
  }
  const bridge = makeServer(config);
  await new Promise((resolve, reject) => {
    bridge.httpServer.once("error", reject);
    bridge.httpServer.listen(config.port, "127.0.0.1", resolve);
  });
  const waitMs = Number.parseInt(
    options.get("wait-ms") ||
      process.env.ORBIT_AUDIT_WAIT_MS ||
      `${DEFAULT_WAIT_MS}`,
    10,
  );
  let connection;
  try {
    connection = await bridge.waitForConnection(waitMs);
  } catch (error) {
    bridge.httpServer.close();
    console.error(JSON.stringify({ status: "BLOCKED", reason: error.message }));
    process.exitCode = 2;
    return;
  }
  try {
    if (command === "preflight" || command === "sources") {
      printResult(command, await sendCommand(connection, command));
      return;
    }
    if (command === "chat") {
      const message = options.get("message");
      if (!message) throw new Error("--message が必要です。");
      const conversation =
        options.get("conversation") || randomBytes(12).toString("base64url");
      const payload = await sendCommand(connection, "chat", {
        conversation_id: conversation,
        message,
        source_ref: options.get("source-ref") || null,
      });
      printResult(command, payload);
      return;
    }
    if (command === "run") {
      const scenarioPath = options.get("scenario") || options.get("file");
      const positional = process.argv[3];
      const path = scenarioPath || positional;
      if (!path) throw new Error("シナリオJSONのパスが必要です。");
      const scenario = JSON.parse(await readFile(resolve(path), "utf8"));
      const scenarios = Array.isArray(scenario.scenarios)
        ? scenario.scenarios
        : [scenario];
      if (scenarios.length === 0) throw new Error("scenarioが空です。");
      const preflight = await sendCommand(connection, "preflight");
      if (!isKnownPreflight(preflight)) {
        printBlocked(
          "run",
          "実認証live capabilityまたは認証済みSCombZ sourceを確認できません。",
          { preflight },
        );
        process.exitCode = 2;
        return;
      }
      const runs = [];
      for (const [scenarioIndex, item] of scenarios.entries()) {
        if (!Array.isArray(item?.turns) || item.turns.length === 0) {
          throw new Error(`scenario ${scenarioIndex + 1} のturnsが空です。`);
        }
        let conversation =
          item.conversation_id || randomBytes(12).toString("base64url");
        const turns = [];
        // A source ref is an explicit operator choice.  It is never inferred
        // from the active tab; this option only avoids repeating the same ref
        // on every turn when `sources` returned multiple candidates.
        const defaultSourceRef = options.get("source-ref") || null;
        for (const [index, turn] of item.turns.entries()) {
          if (
            !turn ||
            typeof turn.message !== "string" ||
            !turn.message.trim()
          ) {
            throw new Error(
              `scenario ${scenarioIndex + 1} turn ${index + 1} のmessageが不正です。`,
            );
          }
          if (turn.new_chat === true) {
            await sendCommand(connection, "clear", {
              conversation_id: conversation,
            });
            conversation = randomBytes(12).toString("base64url");
          }
          const result = await sendCommand(connection, "chat", {
            conversation_id: conversation,
            message: turn.message,
            source_ref: turn.source_ref || defaultSourceRef,
          });
          turns.push({
            user: turn.message,
            conversation_id: conversation,
            new_chat: turn.new_chat === true,
            agent: result,
          });
        }
        runs.push({
          scenario_id: item.scenario_id || null,
          conversation_id: conversation,
          turns,
        });
        // A finite audit scenario is a conversation boundary.  Release the
        // extension-side provider history, pseudonymization map, SCombZ
        // handles, and syllabus refs before moving to the next scenario.
        const cleared = await sendCommand(connection, "clear", {
          conversation_id: conversation,
        });
        if (cleared?.status !== "known") {
          throw new Error("監査シナリオの会話境界を破棄できませんでした。");
        }
      }
      printResult("run", {
        scenario_id: scenario.scenario_id || null,
        preflight,
        runs,
      });
      return;
    }
    throw new Error(`未知のcommand: ${command}`);
  } catch (error) {
    console.error(JSON.stringify({ status: "BLOCKED", reason: error.message }));
    process.exitCode = 2;
  } finally {
    connection.close();
    bridge.httpServer.close();
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ status: "BLOCKED", reason: error.message }));
  process.exitCode = 2;
});

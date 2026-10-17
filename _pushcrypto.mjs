/* The exact VAPID + RFC 8291 code worker.js carries, checked against http_ece (the decryptor
   web-push itself uses) and jose (an independent JWT verifier). Nothing here ships except the
   functions copied into worker.js; kept as the repeatable check behind them, and it needs the
   test-only packages DEPLOY.md's install line adds (node_modules is gitignored). */
import { createECDH } from "node:crypto";
import ece from "http_ece";
import * as jose from "jose";

const enc = new TextEncoder();
const b64u = (bytes) => Buffer.from(new Uint8Array(bytes)).toString("base64url");
const unb64u = (s) => new Uint8Array(Buffer.from(String(s), "base64url"));

/* HKDF-SHA256: extract = HMAC(salt, ikm); expand (one block) = HMAC(prk, info || 0x01). */
async function hkdf(ikm, salt, info, len) {
  /* Extract is HMAC(key = salt, message = ikm) - the arguments the other way round produce a
     perfectly valid-looking PRK that no push service can decrypt. */
  const k = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", k, ikm));
  const pk = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const t = new Uint8Array(await crypto.subtle.sign("HMAC", pk, new Uint8Array([...info, 1])));
  return t.slice(0, len);
}

async function encryptPush(payloadStr, p256dh, authSecret) {
  const uaPub = unb64u(p256dh), auth = unb64u(authSecret);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const info = new Uint8Array([...enc.encode("WebPush: info"), 0, ...uaPub, ...asPub]);
  const ikm = await hkdf(ecdh, auth, info, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, new Uint8Array([...enc.encode("Content-Encoding: aes128gcm"), 0]), 16);
  const nonce = await hkdf(ikm, salt, new Uint8Array([...enc.encode("Content-Encoding: nonce"), 0]), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = new Uint8Array([...enc.encode(payloadStr), 2]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, plain));
  const rec = new Uint8Array(16 + 4 + 1 + 65 + ct.length);
  rec.set(salt, 0);
  new DataView(rec.buffer).setUint32(16, 4096, false);
  rec[20] = 65;
  rec.set(asPub, 21);
  rec.set(ct, 86);
  return rec;
}

async function vapidHeader(endpoint, jwk) {
  const pub = b64u(new Uint8Array([4, ...unb64u(jwk.x), ...unb64u(jwk.y)]));
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:test@example.com" })));
  const signed = head + "." + body;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signed)));
  return { header: "vapid t=" + signed + "." + b64u(sig) + ", k=" + pub, pub, jwt: signed + "." + b64u(sig) };
}

let fails = 0;
const ok = (label, cond, extra) => { if (!cond) fails++; console.log((cond ? "PASS  " : "FAIL  ") + label + (extra ? "  -> " + extra : "")); };

/* --- the "phone": a receiver keypair + 16-byte auth secret --- */
const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const uaPub = b64u(await crypto.subtle.exportKey("raw", ua.publicKey));
const uaJwk = await crypto.subtle.exportKey("jwk", ua.privateKey);
const auth = crypto.getRandomValues(new Uint8Array(16));
const authB64 = b64u(auth);

const payload = JSON.stringify({ title: "3 cards due today", body: "site visit · invoice · calibration" });
const record = await encryptPush(payload, uaPub, authB64);
ok("record has the 86-byte aes128gcm header (salt 16 + rs 4 + idlen 1 + keyid 65)", record.length > 86 + payload.length && record[20] === 65, record.length + " bytes");

/* independent decryptor: http_ece, the library web-push uses */
let decrypted = null;
const uaKeyObject = createECDH("prime256v1");
uaKeyObject.setPrivateKey(Buffer.from(uaJwk.d, "base64url"));
const decryptWith = (buf) => ece.decrypt(Buffer.from(buf), { version: "aes128gcm", privateKey: uaKeyObject, authSecret: Buffer.from(auth) }).toString();
try { decrypted = decryptWith(record); } catch (e) { decrypted = { err: String(e).slice(0, 160) }; }
ok("http_ece decrypts my payload back to the exact JSON", decrypted === payload, typeof decrypted === "string" ? decrypted.slice(0, 40) + "…" : JSON.stringify(decrypted));

/* the test must be able to fail: a flipped ciphertext byte has to break authentication */
const tampered = new Uint8Array(record); tampered[tampered.length - 1] ^= 1;
let tamperErr = "";
try { decryptWith(tampered); } catch (e) { tamperErr = String(e); }
ok("a tampered record is rejected (the check above is real)", tamperErr !== "", tamperErr.split("\n")[0].slice(0, 60));

/* --- VAPID --- */
const vap = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapJwk = await crypto.subtle.exportKey("jwk", vap.privateKey);
const vapPubJwk = await crypto.subtle.exportKey("jwk", vap.publicKey);
const v = await vapidHeader("https://fcm.googleapis.com/fcm/send/abc123", vapJwk);
const [, t] = v.header.match(/^vapid t=([^,]+), k=(.+)$/) || [];
const verified = await jose.jwtVerify(t, await jose.importJWK({ kty: "EC", crv: "P-256", x: vapPubJwk.x, y: vapPubJwk.y }, "ES256"), { audience: "https://fcm.googleapis.com" });
ok("jose verifies the ES256 JWT and its aud", verified.payload.aud === "https://fcm.googleapis.com" && verified.payload.sub === "mailto:test@example.com", JSON.stringify(verified.payload));
ok("the k= value is the 87-char uncompressed public key", v.pub.length === 87 && unb64u(v.pub)[0] === 4, v.pub.slice(0, 16) + "…");
ok("the k= value matches the signing key", v.pub === b64u(new Uint8Array([4, ...unb64u(vapPubJwk.x), ...unb64u(vapPubJwk.y)])), "derived from x/y");
const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const wrong = await crypto.subtle.exportKey("jwk", other.publicKey);
let wrongErr = "";
try { await jose.jwtVerify(t, await jose.importJWK({ kty: "EC", crv: "P-256", x: wrong.x, y: wrong.y }, "ES256"), { audience: "https://fcm.googleapis.com" }); } catch (e) { wrongErr = String(e); }
ok("a JWT signed by another key is rejected", wrongErr !== "", wrongErr.slice(0, 40));

console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASS");
process.exit(fails ? 1 : 0);

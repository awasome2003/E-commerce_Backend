import pkg from "@prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

const { PrismaClient } = pkg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// Build the adapter from the URL's parts rather than the string, so connection
// options can be added.
const url = new URL(process.env.DATABASE_URL);

const adapter = new PrismaMariaDb({
  host: url.hostname,
  port: Number(url.port) || 3306,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ""),

  // MySQL 8's default auth (caching_sha2_password) sends the password encrypted
  // with the server's RSA public key on a fresh, non-TLS connection. The client
  // must fetch that key, and without this flag the driver refuses to — so the
  // FIRST connection after the server restarts fails with "RSA public key is not
  // available client side" (the server's auth cache having been cleared). It
  // works until a restart, then breaks, which is exactly a cold-start failure on
  // a hosted database.
  //
  // The theoretical cost is a MITM on that initial key exchange over plaintext;
  // the real fix for an untrusted network is TLS (`ssl: true`), where the
  // password is protected by the channel. On localhost and a provider's private
  // network this is safe.
  allowPublicKeyRetrieval: true,
});

export const prisma = new PrismaClient({ adapter });

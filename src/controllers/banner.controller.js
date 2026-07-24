import { prisma } from "../lib/prisma.js";
import { ACTIVE, forCreate, forUpdate, forSoftDelete } from "../lib/records.js";
import { safeDate, safeDates } from "../lib/dates.js";

const BANNER_DATES = ["date_from", "date_to", "created_at", "updated_at", "deleted_at"];

/**
 * Banner ads.
 *
 * `image_url` points at an existing S3 bucket
 * (flexicart-assets.s3.ap-south-1.amazonaws.com). There is no upload pipeline
 * and no bucket credentials here, so this module takes a URL string and previews
 * it. Real uploads are separate work.
 *
 * `title`, `link`, `image_url`, `date_from` and `date_to` are all NOT NULL.
 */

const WRITABLE = ["title", "link", "image_url", "date_from", "date_to"];

/**
 * Four banner rows store 0000-00-00 in `date_to`. Comparing an Invalid Date
 * always returns false, so an unguarded check would fall through and report a
 * broken banner as "live" — showing it to customers. Say "unknown" instead.
 */
function windowState(row, now) {
  const from = safeDate(row.date_from);
  const to = safeDate(row.date_to);
  if (!from || !to) return "unknown";
  if (from > now) return "scheduled";
  if (to < now) return "expired";
  return "live";
}

function pickWritable(body) {
  const data = {};
  for (const key of WRITABLE) {
    if (body[key] === undefined) continue;
    data[key] = key.startsWith("date_") ? new Date(body[key]) : body[key];
  }
  return data;
}

function validate(data, { partial } = {}) {
  const required = ["title", "link", "image_url", "date_from", "date_to"];
  if (!partial) {
    const missing = required.filter((k) => data[k] === undefined || data[k] === "" || data[k] === null);
    if (missing.length) return `Missing required fields: ${missing.join(", ")}`;
  }

  for (const key of ["date_from", "date_to"]) {
    if (data[key] !== undefined && Number.isNaN(data[key]?.getTime?.())) {
      return `${key} is not a valid date`;
    }
  }

  if (data.date_from && data.date_to && data.date_from > data.date_to) {
    return "date_from must be on or before date_to";
  }
  return null;
}

/**
 * `link` and `image_url` are rendered as href/src in the admin UI, so a stored
 * `javascript:` / `data:` / `vbscript:` value would be a stored-XSS payload.
 * Allow only absolute http(s) URLs. Checks only the fields present in THIS
 * request (never re-validates a legacy stored value on an unrelated edit).
 */
function validateUrls(data) {
  for (const key of ["link", "image_url"]) {
    if (data[key] === undefined) continue;
    const value = String(data[key]).trim();
    if (value === "") continue; // required-ness is handled by validate()
    let url;
    try {
      url = new URL(value);
    } catch {
      return `${key} must be a valid URL`;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return `${key} must be an http or https URL`;
    }
  }
  return null;
}

export async function listBanners(req, res, next) {
  try {
    const rows = await prisma.master_banner_ads.findMany({
      where: ACTIVE,
      orderBy: { date_from: "desc" },
    });

    const now = new Date();
    res.json(rows.map((row) => ({ ...safeDates(row, BANNER_DATES), state: windowState(row, now) })));
  } catch (err) {
    next(err);
  }
}

export async function getBanner(req, res, next) {
  try {
    const row = await prisma.master_banner_ads.findFirst({
      where: { id: Number(req.params.id), ...ACTIVE },
    });
    if (!row) return res.status(404).json({ message: "Banner not found" });
    res.json({ ...safeDates(row, BANNER_DATES), state: windowState(row, new Date()) });
  } catch (err) {
    next(err);
  }
}

export async function createBanner(req, res, next) {
  try {
    const data = pickWritable(req.body);
    const error = validate(data) || validateUrls(data);
    if (error) return res.status(400).json({ message: error });

    const row = await prisma.master_banner_ads.create({ data: forCreate(req.user.id, data) });
    res.status(201).json({ ...row, state: windowState(row, new Date()) });
  } catch (err) {
    next(err);
  }
}

export async function updateBanner(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.master_banner_ads.findFirst({ where: { id, ...ACTIVE } });
    if (!existing) return res.status(404).json({ message: "Banner not found" });

    const data = pickWritable(req.body);
    // Range-check against the stored row so a partial edit cannot invert the window.
    const merged = { ...existing, ...data };
    const error = validate(merged, { partial: true }) || validate(merged) || validateUrls(data);
    if (error) return res.status(400).json({ message: error });

    const row = await prisma.master_banner_ads.update({
      where: { id },
      data: forUpdate(req.user.id, data),
    });
    res.json({ ...safeDates(row, BANNER_DATES), state: windowState(row, new Date()) });
  } catch (err) {
    next(err);
  }
}

export async function deleteBanner(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.master_banner_ads.findFirst({
      where: { id, ...ACTIVE },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ message: "Banner not found" });

    await prisma.master_banner_ads.update({ where: { id }, data: forSoftDelete(req.user.id) });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

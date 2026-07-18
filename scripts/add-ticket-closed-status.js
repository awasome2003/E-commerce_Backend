import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { ACTIVE, forCreate } from "../src/lib/records.js";

/**
 * Adds the terminal ticket state.
 *
 * `master_ticket_status` shipped with only "Pending" and "status update", so a
 * support agent could never finish a ticket. Client confirmed a closed state is
 * wanted.
 *
 * Idempotent — safe to re-run, and **must also be run against the upstream RDS**
 * or the next dump will arrive without a terminal state again.
 */
const TITLE = "Closed";
const COLOUR = "#067647"; // green, matching the panel's "done" tone

const existing = await prisma.master_ticket_status.findFirst({
  where: { title: TITLE, ...ACTIVE },
  select: { id: true },
});

if (existing) {
  console.log(`'${TITLE}' status already exists (id=${existing.id}) — nothing to do.`);
} else {
  const created = await prisma.master_ticket_status.create({
    data: forCreate(null, { title: TITLE, color: COLOUR }),
    select: { id: true, title: true, color: true },
  });
  console.log(`Created status: id=${created.id} '${created.title}' ${created.color}`);
}

const all = await prisma.master_ticket_status.findMany({
  where: ACTIVE,
  select: { id: true, title: true, color: true },
  orderBy: { id: "asc" },
});
console.log("\nTicket statuses now:");
for (const s of all) console.log(`  ${s.id}  ${s.title.padEnd(16)} ${s.color ?? ""}`);

await prisma.$disconnect();

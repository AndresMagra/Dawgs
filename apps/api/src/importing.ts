/**
 * Bring a daycare's clients over from another system with a CSV export.
 * A dry run shows what would happen; the real run adds owners and dogs,
 * matching owners already on file (and earlier rows of the same file) by
 * email, then phone, then exact name, and never adding the same dog twice.
 * Vaccine dates from the old system count as verified by the person
 * importing, since the old system's staff already checked them.
 */

import { eq } from 'drizzle-orm';
import { phoneKey, readImport, type ImportRow } from '@dawgs/core';
import { dogs, owners, vaccines } from '@dawgs/db';
import type { AppContext } from './context.js';
import { audit } from './audit.js';

export async function importClients(ctx: AppContext, args: { businessId: string; csv: string; dryRun: boolean; actor: string }) {
  const { rows, problems, columns } = readImport(args.csv);
  const existingOwners = await ctx.db.select().from(owners).where(eq(owners.businessId, args.businessId));
  const existingDogs = await ctx.db.select({ id: dogs.id, ownerId: dogs.ownerId, name: dogs.name }).from(dogs).where(eq(dogs.businessId, args.businessId));

  type Known = { id: string | null; name: string; email: string | null; phone: string | null; isNew: boolean; temp: string };
  const known: Known[] = existingOwners.map((o) => ({ id: o.id, name: o.name, email: o.email?.toLowerCase() ?? null, phone: o.phone, isNew: false, temp: o.id }));
  const dogKeys = new Set(existingDogs.map((d) => `${d.ownerId}|${d.name.trim().toLowerCase()}`));
  const find = (o: ImportRow['owner']) =>
    (o.email && known.find((k) => k.email === o.email)) ||
    (phoneKey(o.phone).length >= 7 && known.find((k) => phoneKey(k.phone) === phoneKey(o.phone))) ||
    known.find((k) => k.name.trim().toLowerCase() === o.name.trim().toLowerCase()) ||
    null;

  const counts = { ownersNew: 0, ownersMatched: 0, dogsNew: 0, dogsSkipped: 0, vaccines: 0 };
  const preview: { line: number; owner: string; ownerIsNew: boolean; dog: string | null; dogIsNew: boolean; vaccines: string[] }[] = [];
  const matchedOnce = new Set<string>();
  let n = 0;

  for (const row of rows) {
    let owner = find(row.owner);
    if (!owner) {
      owner = { id: null, name: row.owner.name, email: row.owner.email, phone: row.owner.phone, isNew: true, temp: `new-${n++}` };
      if (!args.dryRun) {
        const [o] = await ctx.db
          .insert(owners)
          .values({ businessId: args.businessId, ...row.owner, notes: 'Imported' })
          .returning({ id: owners.id });
        owner.id = o!.id;
        owner.temp = o!.id;
      }
      known.push(owner);
      counts.ownersNew++;
    } else if (!owner.isNew && !matchedOnce.has(owner.temp)) {
      matchedOnce.add(owner.temp);
      counts.ownersMatched++;
      // Fill blanks on a client already on file; never overwrite what the desk typed.
      if (!args.dryRun && owner.id) {
        const cur = existingOwners.find((o) => o.id === owner!.id)!;
        const fill = Object.fromEntries(
          (['email', 'phone', 'address', 'emergencyName', 'emergencyPhone', 'vetName', 'vetPhone'] as const).filter((k) => !cur[k] && row.owner[k]).map((k) => [k, row.owner[k]]),
        );
        if (Object.keys(fill).length) await ctx.db.update(owners).set(fill).where(eq(owners.id, owner.id));
      }
    }

    let dogIsNew = false;
    if (row.dog) {
      const key = `${owner.temp}|${row.dog.name.trim().toLowerCase()}`;
      if (dogKeys.has(key)) counts.dogsSkipped++;
      else {
        dogKeys.add(key);
        dogIsNew = true;
        counts.dogsNew++;
        counts.vaccines += row.vaccines.length;
        if (!args.dryRun) {
          const d = row.dog;
          const medications = d.medications ? [{ name: d.medications, dose: '', when: '' }] : [];
          const [made] = await ctx.db
            .insert(dogs)
            .values({
              businessId: args.businessId,
              ownerId: owner.id!,
              name: d.name,
              breed: d.breed,
              sex: d.sex,
              fixed: d.fixed,
              birthDate: d.birthDate,
              weightLb: d.weightLb,
              color: d.color,
              feeding: d.feeding,
              allergies: d.allergies,
              medications,
              behaviour: d.notes ? { notes: d.notes } : {},
            })
            .returning({ id: dogs.id });
          for (const v of row.vaccines) {
            await ctx.db.insert(vaccines).values({
              businessId: args.businessId,
              dogId: made!.id,
              name: v.name,
              expiresAt: new Date(`${v.expiresOn}T23:59:59Z`),
              verifiedBy: `${args.actor} (import)`,
            });
          }
        }
      }
    }
    if (preview.length < 25) preview.push({ line: row.line, owner: owner.name, ownerIsNew: owner.isNew, dog: row.dog?.name ?? null, dogIsNew, vaccines: row.vaccines.map((v) => `${v.name} ${v.expiresOn}`) });
  }

  if (!args.dryRun) {
    await audit(ctx.db, args.businessId, args.actor, 'clients.import', `Imported ${counts.ownersNew} new owners and ${counts.dogsNew} dogs (${counts.ownersMatched} owners already on file)`);
  }
  return {
    dryRun: args.dryRun,
    ...counts,
    rows: rows.length,
    columns: { recognised: Object.keys(columns.fields), vaccines: columns.vaccines.map((v) => v.name), ignored: columns.ignored },
    problems: problems.slice(0, 100),
    preview,
  };
}


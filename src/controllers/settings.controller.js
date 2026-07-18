import { prisma } from "../lib/prisma.js";
import { ACTIVE, forCreate, forUpdate, forSoftDelete } from "../lib/records.js";
import { ACTIONS, MODULES } from "../middleware/rbac.js";

/**
 * Role/module permission editing.
 *
 * Three things this schema forces:
 *  - The matrix is **sparse**: 37 rows against a 4x8 grid, and a missing
 *    (role, module) row means deny. Rows are created on demand.
 *  - There is no unique index on (role_id, module_id), so writes are
 *    find-then-update/create rather than a Prisma upsert.
 *  - Retired roles and modules are soft-deleted but still have permission rows
 *    pointing at them (`Brands`, `Role 1`, the duplicate `Customer`). Only active
 *    roles and modules are listed or written, so the editor cannot resurrect them.
 *
 * Role titles are not unique — two roles are called "Customer" — so everything
 * keys on id.
 */

export async function getPermissionMatrix(req, res, next) {
  try {
    const [roles, modules, rows] = await Promise.all([
      prisma.master_roles.findMany({
        where: ACTIVE,
        select: { id: true, title: true },
        orderBy: { id: "asc" },
      }),
      prisma.master_module.findMany({
        where: ACTIVE,
        select: { id: true, title: true },
        orderBy: { id: "asc" },
      }),
      prisma.master_role_permissions.findMany({
        where: { ...ACTIVE, master_roles: ACTIVE, master_module: ACTIVE },
        select: {
          role_id: true,
          module_id: true,
          create: true,
          read: true,
          update: true,
          delete: true,
        },
      }),
    ]);

    const byRole = new Map();
    for (const row of rows) {
      if (!byRole.has(row.role_id)) byRole.set(row.role_id, {});
      byRole.get(row.role_id)[row.module_id] = {
        create: row.create === 1,
        read: row.read === 1,
        update: row.update === 1,
        delete: row.delete === 1,
      };
    }

    // Fill the grid so the client never has to reason about missing rows.
    const blank = () => Object.fromEntries(ACTIONS.map((a) => [a, false]));
    const matrix = roles.map((role) => ({
      role_id: role.id,
      role: role.title,
      modules: Object.fromEntries(
        modules.map((m) => [m.id, byRole.get(role.id)?.[m.id] ?? blank()]),
      ),
    }));

    res.json({ roles, modules, matrix, current_role_id: req.user.role_id });
  } catch (err) {
    next(err);
  }
}

/**
 * Roles, with their user counts.
 *
 * Titles are not unique in this data — two roles are called "Customer" (one
 * retired) — so the UI must key on id and show the count to tell them apart.
 */
export async function listRolesWithCounts(req, res, next) {
  try {
    const roles = await prisma.master_roles.findMany({
      where: ACTIVE,
      select: {
        id: true,
        title: true,
        _count: {
          select: {
            users: { where: ACTIVE },
            // Count rows on active modules only, or this disagrees with the
            // permission grid: Manager holds a stale row on the retired `Brands`
            // module and would otherwise report 9 rows against 8 modules.
            master_role_permissions: { where: { ...ACTIVE, master_module: ACTIVE } },
          },
        },
      },
      orderBy: { id: "asc" },
    });
    res.json(roles.map((r) => ({
      id: r.id,
      title: r.title,
      users: r._count.users,
      permission_rows: r._count.master_role_permissions,
      is_current: r.id === req.user.role_id,
    })));
  } catch (err) {
    next(err);
  }
}

export async function createRole(req, res, next) {
  try {
    const { title } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ message: "title is required" });

    const clash = await prisma.master_roles.findFirst({
      where: { title: title.trim(), ...ACTIVE },
      select: { id: true },
    });
    if (clash) {
      return res.status(409).json({ message: `A role called '${title.trim()}' already exists` });
    }

    // Created with no permission rows at all: the matrix is sparse and missing
    // means deny, so a new role starts with no access until granted.
    const role = await prisma.master_roles.create({
      data: forCreate(req.user.id, { title: title.trim() }),
      select: { id: true, title: true },
    });
    res.status(201).json(role);
  } catch (err) {
    next(err);
  }
}

export async function updateRole(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { title } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ message: "title is required" });

    const role = await prisma.master_roles.findFirst({ where: { id, ...ACTIVE }, select: { id: true } });
    if (!role) return res.status(404).json({ message: "Role not found" });

    const clash = await prisma.master_roles.findFirst({
      where: { title: title.trim(), id: { not: id }, ...ACTIVE },
      select: { id: true },
    });
    if (clash) {
      return res.status(409).json({ message: `A role called '${title.trim()}' already exists` });
    }

    const updated = await prisma.master_roles.update({
      where: { id },
      data: forUpdate(req.user.id, { title: title.trim() }),
      select: { id: true, title: true },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

/**
 * Retire a role.
 *
 * Roles are referenced by `users.role_id` with no cascade, so soft-deleting one
 * that still has users would strand them: `getPermissions` joins through active
 * roles, so those users would silently lose all access while still appearing to
 * have a role. Refuse instead, and make the caller move the users first.
 */
export async function deleteRole(req, res, next) {
  try {
    const id = Number(req.params.id);

    if (id === req.user.role_id) {
      return res.status(409).json({ message: "You cannot retire your own role." });
    }

    const role = await prisma.master_roles.findFirst({
      where: { id, ...ACTIVE },
      select: { id: true, title: true, _count: { select: { users: { where: ACTIVE } } } },
    });
    if (!role) return res.status(404).json({ message: "Role not found" });

    if (role._count.users > 0) {
      return res.status(409).json({
        message:
          `'${role.title}' still has ${role._count.users} user(s). ` +
          "Move them to another role before retiring it.",
      });
    }

    await prisma.master_roles.update({ where: { id }, data: forSoftDelete(req.user.id) });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function updatePermissions(req, res, next) {
  try {
    const roleId = Number(req.params.roleId);
    const { modules: payload } = req.body;

    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ message: "modules object is required" });
    }

    const role = await prisma.master_roles.findFirst({
      where: { id: roleId, ...ACTIVE },
      select: { id: true, title: true },
    });
    if (!role) return res.status(404).json({ message: "Role not found" });

    const activeModules = await prisma.master_module.findMany({
      where: ACTIVE,
      select: { id: true, title: true },
    });
    const moduleById = new Map(activeModules.map((m) => [String(m.id), m]));

    const unknown = Object.keys(payload).filter((id) => !moduleById.has(id));
    if (unknown.length) {
      return res.status(400).json({ message: `Unknown or retired module ids: ${unknown.join(", ")}` });
    }

    const settingsModule = activeModules.find((m) => m.title === MODULES.SETTINGS);

    // --- lockout guard ----------------------------------------------------
    // This endpoint sits behind Settings.update, so the caller's own role always
    // holds it. That makes editing your own role the only way to drop the system
    // to zero roles with Settings.update — editing any other role still leaves
    // yours holding it. Blocking self-removal is therefore sufficient to keep the
    // "at least one role can edit permissions" invariant; a separate last-role
    // check would never fire.
    if (settingsModule && roleId === req.user.role_id) {
      const requested = payload[String(settingsModule.id)];
      if (requested && requested.update === false) {
        return res.status(409).json({
          message:
            "You cannot remove 'Settings > update' from your own role — it would lock every admin out of this screen.",
        });
      }
    }
    // ----------------------------------------------------------------------

    const existing = await prisma.master_role_permissions.findMany({
      where: { role_id: roleId, ...ACTIVE },
      select: { id: true, module_id: true },
    });
    const rowByModule = new Map(existing.map((r) => [String(r.module_id), r.id]));

    await prisma.$transaction(async (tx) => {
      for (const [moduleId, flags] of Object.entries(payload)) {
        const data = Object.fromEntries(ACTIONS.map((a) => [a, flags?.[a] ? 1 : 0]));
        const rowId = rowByModule.get(moduleId);

        if (rowId) {
          await tx.master_role_permissions.update({
            where: { id: rowId },
            data: forUpdate(req.user.id, data),
          });
        } else {
          await tx.master_role_permissions.create({
            data: forCreate(req.user.id, {
              ...data,
              role_id: roleId,
              module_id: Number(moduleId),
            }),
          });
        }
      }
    });

    res.json({ role_id: roleId, updated: Object.keys(payload).length });
  } catch (err) {
    next(err);
  }
}

# 42space Agent Notes

## Documentation Contract

Before code changes, read:

- `docs/plan.md`
- `docs/todo.md`
- The indexed subplan/subtodo for the area being changed

After code changes, update:

- `docs/plan.md` if the active stage, scope, or decision changed
- `docs/todo.md` if priorities or task status changed
- The affected `docs/plans/*` and `docs/todos/*` files with detailed status

Keep top-level docs short. Put implementation details, evidence, and checklists in subdocs.

## Safety

- Do not commit secrets, RPC keys, private keys, or webhook URLs.
- Prefer `npm run verify` after code changes.
- Keep production facts separate from local assumptions.

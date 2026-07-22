# Mike workflow synchronization

Vera generates `backend/src/lib/systemWorkflows.ts` from the public
`Open-Legal-Products/mike-workflows` repository. The synchronization boundary is
fully declared in `scripts/mike-workflows.lock.json`:

- upstream repository and immutable commit
  `d27064ae8085d3e8ebca99d5a491c9804376cbc7`;
- an explicit allowlist of 13 assistant and 11 tabular workflows;
- expected workflow counts, semantic SHA-256, and generated-file SHA-256.

Only direct children named in the allowlist are read. Pack directories and all
other upstream workflows are ignored, so the Finnish law pack and future add-on
packs cannot enter Vera's default runtime by discovery.

## Commands

Run from `backend/`:

```bash
npm run test:workflow-sync
npm run workflows:check
npm run workflows:sync
```

`workflows:check` clones only the locked commit into a temporary directory,
generates the artifact in memory, verifies both locked hashes, and fails if the
committed TypeScript differs byte-for-byte. It never writes the repository.

`workflows:sync` performs the same validation and writes the generated file only
when necessary. A local checkout can be used without a network fetch, but its
HEAD must equal the locked commit:

```bash
node ../scripts/build-workflows.js --check --source /path/to/mike-workflows
```

The GitHub fetch exists only in this developer/build command. The generated
runtime module contains static data and does not import the synchronization
tool, access GitHub, add persistence, or change any API.

## Updating the pin

An upstream update is deliberate: review the proposed workflow diff, update the
commit and explicit allowlists, regenerate, and then update the two expected
hashes in the lock file. Do not replace the allowlists with directory discovery.
The output must remain 24 workflows unless the product requirement explicitly
changes.

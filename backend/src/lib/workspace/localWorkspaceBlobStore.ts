import {
  Buffer,
} from "node:buffer";
import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  applicationEncryptionMode,
  decryptLocalBuffer,
  encryptLocalBuffer,
  type LocalFilePurpose,
} from "../aletheia/localEnvelopeCrypto";
import type {
  BlobIntegrity,
  BlobStore,
  StoredWorkspaceBlob,
  WorkspaceBlobCodec,
  WorkspaceBlobCodecPurpose,
  WorkspaceBlobDeleteReceipt,
  WorkspaceBlobLocator,
} from "./blobStore";

const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const DELETE_MANIFEST_SUFFIX = ".delete.json";
const RFC4122_UUID_V1_TO_V8 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkspaceBlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBlobError";
  }
}

export class WorkspaceBlobConfigurationError extends WorkspaceBlobError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBlobConfigurationError";
  }
}

export class WorkspaceBlobUnsafePathError extends WorkspaceBlobError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBlobUnsafePathError";
  }
}

export class WorkspaceBlobAlreadyExistsError extends WorkspaceBlobError {
  constructor(locator: WorkspaceBlobLocator) {
    super(`Workspace blob already exists for kind ${locator.kind}.`);
    this.name = "WorkspaceBlobAlreadyExistsError";
  }
}

export class WorkspaceBlobNotFoundError extends WorkspaceBlobError {
  constructor(locator: WorkspaceBlobLocator) {
    super(`Workspace blob was not found for kind ${locator.kind}.`);
    this.name = "WorkspaceBlobNotFoundError";
  }
}

export class WorkspaceBlobIntegrityError extends WorkspaceBlobError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBlobIntegrityError";
  }
}

export class LocalEnvelopeWorkspaceBlobCodec implements WorkspaceBlobCodec {
  readonly encrypted = true;

  private purpose(purpose: WorkspaceBlobCodecPurpose): LocalFilePurpose {
    return purpose === "local_export" ? "local_export" : "source_document";
  }

  private requireEncryption() {
    if (applicationEncryptionMode() !== "required") {
      throw new WorkspaceBlobConfigurationError(
        "Workspace blobs require application encryption; configure the existing local envelope master key before using the production codec.",
      );
    }
  }

  encode(args: {
    filePath: string;
    plaintext: Buffer;
    purpose: WorkspaceBlobCodecPurpose;
  }) {
    this.requireEncryption();
    return encryptLocalBuffer({
      filePath: args.filePath,
      plaintext: args.plaintext,
      purpose: this.purpose(args.purpose),
    });
  }

  decode(args: {
    filePath: string;
    envelope: Buffer;
    purpose: WorkspaceBlobCodecPurpose;
  }) {
    this.requireEncryption();
    return decryptLocalBuffer({
      filePath: args.filePath,
      envelope: args.envelope,
      purpose: this.purpose(args.purpose),
    });
  }
}

export type LocalWorkspaceBlobStoreOptions = {
  root: string;
  codec?: WorkspaceBlobCodec;
  /** Only focused tests may opt into an explicitly injected plaintext codec. */
  allowUnencryptedCodec?: boolean;
};

function isUuid(value: unknown): value is string {
  return typeof value === "string" && RFC4122_UUID_V1_TO_V8.test(value);
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (!isUuid(value)) {
    throw new WorkspaceBlobUnsafePathError(
      `${label} must be an RFC 4122 UUID (version 1-8).`,
    );
  }
}

function hash(plaintext: Buffer) {
  return createHash("sha256").update(plaintext).digest("hex");
}

export class LocalWorkspaceBlobStore implements BlobStore {
  readonly root: string;
  private readonly codec: WorkspaceBlobCodec;

  constructor(options: LocalWorkspaceBlobStoreOptions) {
    if (!path.isAbsolute(options.root)) {
      throw new WorkspaceBlobConfigurationError(
        "Workspace blob root must be an absolute path.",
      );
    }
    this.root = path.resolve(options.root);
    if (!options.codec && applicationEncryptionMode() !== "required") {
      throw new WorkspaceBlobConfigurationError(
        "The production workspace blob store requires application encryption at construction time.",
      );
    }
    this.codec = options.codec ?? new LocalEnvelopeWorkspaceBlobCodec();
    if (!this.codec.encrypted && !options.allowUnencryptedCodec) {
      throw new WorkspaceBlobConfigurationError(
        "An unencrypted workspace blob codec must be explicitly marked as a test injection.",
      );
    }
    this.ensureRoot();
    this.recoverIncompleteDeleteIntents();
  }

  putSync(
    locator: WorkspaceBlobLocator,
    plaintext: Buffer | string,
  ): StoredWorkspaceBlob {
    this.validateLocator(locator);
    const bytes = Buffer.isBuffer(plaintext)
      ? Buffer.from(plaintext)
      : Buffer.from(plaintext, "utf8");
    const target = this.authoritativePath(locator);
    const parent = path.dirname(target);
    this.ensureDirectory(parent);
    if (this.entryExists(target)) {
      this.recoverInterruptedPublication(target);
      this.assertRegularUnlinkedFile(target);
      throw new WorkspaceBlobAlreadyExistsError(locator);
    }

    const purpose = this.codecPurpose(locator);
    const encoded = this.codec.encode({
      filePath: target,
      plaintext: bytes,
      purpose,
    });
    const temporaryPath = path.join(
      parent,
      `.${path.basename(target)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    let temporaryFd: number | undefined;
    let published = false;
    let temporaryRemoved = false;
    try {
      temporaryFd = openSync(
        temporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        OWNER_FILE_MODE,
      );
      let offset = 0;
      while (offset < encoded.length) {
        offset += writeSync(temporaryFd, encoded, offset, encoded.length - offset);
      }
      chmodSync(temporaryPath, OWNER_FILE_MODE);
      fsyncSync(temporaryFd);
      closeSync(temporaryFd);
      temporaryFd = undefined;
      // Persist the temporary directory entry before it becomes the fallback
      // for a partially-published hardlink operation.
      this.fsyncDirectory(parent);

      // linkSync is the no-clobber publication primitive: renameSync would
      // replace a concurrently-created authoritative blob.
      linkSync(temporaryPath, target);
      published = true;
      this.fsyncFile(target);
      // The authoritative link must be durable before the temporary link is
      // removed. Otherwise a power loss could make both names disappear.
      this.fsyncDirectory(parent);
      unlinkSync(temporaryPath);
      temporaryRemoved = true;
      this.fsyncDirectory(parent);
      published = false;
    } catch (error) {
      if (temporaryFd !== undefined) {
        try {
          closeSync(temporaryFd);
        } catch {
          // Preserve the original write error.
        }
      }
      if (published && !temporaryRemoved) {
        try {
          unlinkSync(target);
          this.fsyncDirectory(parent);
        } catch {
          // A failed cleanup remains fail-closed; read rejects hardlinks and
          // callers can recover the staged file explicitly.
        }
      }
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temp file may already have been unlinked after publication.
      }
      if (this.isAlreadyExistsError(error)) {
        throw new WorkspaceBlobAlreadyExistsError(locator);
      }
      throw error;
    }

    return {
      locator,
      sha256: hash(bytes),
      size: bytes.length,
      storedSize: encoded.length,
    };
  }

  readSync(locator: WorkspaceBlobLocator, expected: BlobIntegrity): Buffer {
    this.validateLocator(locator);
    this.validateIntegrity(expected);
    const target = this.authoritativePath(locator);
    this.ensureDirectory(path.dirname(target));
    this.recoverInterruptedPublication(target);
    const encoded = this.readAuthoritativeFile(target, locator);
    const plaintext = this.codec.decode({
      filePath: target,
      envelope: encoded,
      purpose: this.codecPurpose(locator),
    });
    const actual = { sha256: hash(plaintext), size: plaintext.length };
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new WorkspaceBlobIntegrityError(
        "Workspace blob plaintext hash or size does not match authoritative metadata.",
      );
    }
    return plaintext;
  }

  stageDeleteSync(locator: WorkspaceBlobLocator): WorkspaceBlobDeleteReceipt {
    this.validateLocator(locator);
    const target = this.authoritativePath(locator);
    const parent = path.dirname(target);
    this.ensureDirectory(parent);
    if (!this.entryExists(target)) throw new WorkspaceBlobNotFoundError(locator);
    this.recoverInterruptedPublication(target);
    this.assertRegularUnlinkedFile(target);
    const quarantineDir = path.join(this.root, ".quarantine");
    this.ensureDirectory(quarantineDir);
    const quarantineId = this.newQuarantineId(quarantineDir);
    const quarantinePath = path.join(quarantineDir, quarantineId);
    const manifestPath = this.deleteManifestPath(quarantineId);
    const receipt: WorkspaceBlobDeleteReceipt = {
      status: "staged",
      locator,
      quarantineId,
    };
    let linked = false;
    let manifestWritten = false;
    try {
      this.writeDeleteManifest(receipt, manifestPath);
      manifestWritten = true;
      linkSync(target, quarantinePath);
      linked = true;
      this.fsyncFile(quarantinePath);
      // Make the recovery copy durable before deleting the authoritative
      // directory entry.
      this.fsyncDirectory(quarantineDir);
      unlinkSync(target);
      this.fsyncDirectory(parent);
    } catch (error) {
      if (this.entryExists(target)) {
        try {
          if (linked && this.entryExists(quarantinePath)) {
            unlinkSync(quarantinePath);
          }
          if (manifestWritten && this.entryExists(manifestPath)) {
            unlinkSync(manifestPath);
          }
          this.fsyncDirectory(quarantineDir);
        } catch {
          // Keep the original and quarantine copy for explicit recovery.
        }
      }
      throw error;
    }
    return receipt;
  }

  finalizeDeleteSync(receipt: WorkspaceBlobDeleteReceipt) {
    const { quarantinePath, manifestPath } = this.receiptPaths(receipt);
    if (this.entryExists(this.authoritativePath(receipt.locator))) {
      throw new WorkspaceBlobError(
        "Cannot finalize a staged delete while the authoritative path exists.",
      );
    }
    // Retrying finalize after a crash or successful prior call is safe.
    if (!this.entryExists(quarantinePath) && !this.entryExists(manifestPath)) return;
    this.assertDeleteManifestMatches(receipt, manifestPath);
    if (this.entryExists(quarantinePath)) {
      this.assertRegularUnlinkedFile(quarantinePath);
      unlinkSync(quarantinePath);
    }
    if (this.entryExists(manifestPath)) unlinkSync(manifestPath);
    this.fsyncDirectory(path.dirname(quarantinePath));
  }

  restoreDeleteSync(receipt: WorkspaceBlobDeleteReceipt) {
    const { quarantinePath, manifestPath } = this.receiptPaths(receipt);
    this.assertDeleteManifestMatches(receipt, manifestPath);
    const target = this.authoritativePath(receipt.locator);
    const parent = path.dirname(target);
    this.ensureDirectory(parent);
    if (this.entryExists(target)) {
      throw new WorkspaceBlobAlreadyExistsError(receipt.locator);
    }
    this.assertRegularUnlinkedFile(quarantinePath);
    let published = false;
    let quarantineRemoved = false;
    try {
      linkSync(quarantinePath, target);
      published = true;
      this.fsyncFile(target);
      // Persist the restored authoritative name before removing quarantine.
      this.fsyncDirectory(parent);
      unlinkSync(quarantinePath);
      quarantineRemoved = true;
      unlinkSync(manifestPath);
      this.fsyncDirectory(path.dirname(quarantinePath));
      published = false;
    } catch (error) {
      if (published && !quarantineRemoved) {
        try {
          unlinkSync(target);
          this.fsyncDirectory(parent);
        } catch {
          // Preserve the staged copy if cleanup cannot be completed.
        }
      }
      throw error;
    }
  }

  listStagedDeletesSync(): WorkspaceBlobDeleteReceipt[] {
    this.recoverIncompleteDeleteIntents();
    const quarantineDir = path.join(this.root, ".quarantine");
    return readdirSync(quarantineDir)
      .filter((name) => name.endsWith(DELETE_MANIFEST_SUFFIX))
      .sort()
      .map((name) => {
        const quarantineId = name.slice(0, -DELETE_MANIFEST_SUFFIX.length);
        assertUuid(quarantineId, "quarantineId");
        const receipt = this.readDeleteManifest(
          path.join(quarantineDir, name),
          quarantineId,
        );
        const quarantinePath = path.join(quarantineDir, quarantineId);
        if (!this.entryExists(quarantinePath)) {
          throw new WorkspaceBlobIntegrityError(
            "A staged-delete manifest has no recoverable quarantine blob.",
          );
        }
        return receipt;
      });
  }

  private validateLocator(locator: WorkspaceBlobLocator) {
    if (!locator || typeof locator !== "object") {
      throw new WorkspaceBlobUnsafePathError("Workspace blob locator is invalid.");
    }
    switch (locator.kind) {
      case "original":
      case "extracted_text":
        assertUuid(locator.documentId, "documentId");
        assertUuid(locator.versionId, "versionId");
        return;
      case "preview":
        assertUuid(locator.documentId, "documentId");
        assertUuid(locator.versionId, "versionId");
        if (locator.previewId !== undefined) {
          assertUuid(locator.previewId, "previewId");
        }
        return;
      case "export":
        assertUuid(locator.exportId, "exportId");
        return;
      default:
        throw new WorkspaceBlobUnsafePathError("Workspace blob kind is invalid.");
    }
  }

  private validateIntegrity(expected: BlobIntegrity) {
    if (
      !expected ||
      typeof expected.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      !Number.isSafeInteger(expected.size) ||
      expected.size < 0
    ) {
      throw new WorkspaceBlobIntegrityError("Workspace blob integrity metadata is invalid.");
    }
  }

  private authoritativePath(locator: WorkspaceBlobLocator) {
    let candidate: string;
    if (locator.kind === "export") {
      candidate = path.join(this.root, "exports", locator.exportId);
    } else {
      const versionRoot = path.join(
        this.root,
        "documents",
        locator.documentId,
        "versions",
        locator.versionId,
      );
      if (locator.kind === "original") candidate = path.join(versionRoot, "original");
      else if (locator.kind === "extracted_text") candidate = path.join(versionRoot, "extracted");
      else {
        const previewId = "previewId" in locator ? locator.previewId : undefined;
        candidate = path.join(versionRoot, "preview", previewId ?? "default");
      }
    }
    return this.assertInsideRoot(candidate);
  }

  private codecPurpose(locator: WorkspaceBlobLocator): WorkspaceBlobCodecPurpose {
    return locator.kind === "export" ? "local_export" : "source_document";
  }

  private ensureRoot() {
    if (this.entryExists(this.root)) {
      this.assertDirectory(this.root);
    } else {
      mkdirSync(this.root, { recursive: true, mode: OWNER_DIRECTORY_MODE });
    }
    chmodSync(this.root, OWNER_DIRECTORY_MODE);
    this.assertDirectory(this.root);
  }

  private ensureDirectory(directory: string) {
    const resolved = this.assertInsideRoot(directory);
    const relative = path.relative(this.root, resolved);
    let current = this.root;
    for (const segment of relative ? relative.split(path.sep) : []) {
      current = path.join(current, segment);
      if (this.entryExists(current)) {
        this.assertDirectory(current);
      } else {
        mkdirSync(current, { mode: OWNER_DIRECTORY_MODE });
      }
      chmodSync(current, OWNER_DIRECTORY_MODE);
    }
    this.assertDirectory(resolved);
  }

  private assertDirectory(directory: string) {
    const entry = lstatSync(directory);
    if (entry.isSymbolicLink()) {
      throw new WorkspaceBlobUnsafePathError("Workspace blob directory cannot be a symlink.");
    }
    if (!entry.isDirectory()) {
      throw new WorkspaceBlobUnsafePathError("Workspace blob path component is not a directory.");
    }
  }

  private assertRegularUnlinkedFile(filePath: string) {
    const entry = lstatSync(filePath);
    if (entry.isSymbolicLink()) {
      throw new WorkspaceBlobUnsafePathError("Workspace blob file cannot be a symlink.");
    }
    if (!entry.isFile()) {
      throw new WorkspaceBlobUnsafePathError("Workspace blob target is not a regular file.");
    }
    if (entry.nlink !== 1) {
      throw new WorkspaceBlobUnsafePathError("Workspace blob hardlinks are not accepted.");
    }
  }

  /**
   * A power loss after linking the authoritative name but before unlinking
   * the internal temp name can legitimately leave exactly two links to the
   * same inode. Only that tightly-scoped internal state is repaired; all
   * other hardlink shapes remain fail-closed.
   */
  private recoverInterruptedPublication(filePath: string) {
    if (!this.entryExists(filePath)) return;
    const target = lstatSync(filePath);
    if (!target.isFile() || target.isSymbolicLink() || target.nlink === 1) return;
    if (target.nlink !== 2) {
      throw new WorkspaceBlobUnsafePathError(
        "Workspace blob hardlink state is not recoverable.",
      );
    }
    const parent = path.dirname(filePath);
    const prefix = `.${path.basename(filePath)}.tmp-`;
    const matches = readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(parent, name))
      .filter((candidate) => {
        const entry = lstatSync(candidate);
        return (
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          entry.dev === target.dev &&
          entry.ino === target.ino &&
          entry.nlink === 2
        );
      });
    if (matches.length !== 1) {
      throw new WorkspaceBlobUnsafePathError(
        "Workspace blob hardlink state is not an internal publication remnant.",
      );
    }
    unlinkSync(matches[0]);
    this.fsyncDirectory(parent);
    this.assertRegularUnlinkedFile(filePath);
  }

  private entryExists(filePath: string) {
    try {
      lstatSync(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    }
  }

  private readAuthoritativeFile(filePath: string, locator: WorkspaceBlobLocator) {
    let fd: number | undefined;
    try {
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      fd = openSync(filePath, fsConstants.O_RDONLY | noFollow);
      const entry = fstatSync(fd);
      if (!entry.isFile() || entry.nlink !== 1) {
        throw new WorkspaceBlobUnsafePathError(
          "Workspace blob authoritative file must be a single-link regular file.",
        );
      }
      return readFileSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new WorkspaceBlobNotFoundError(locator);
      }
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private fsyncFile(filePath: string) {
    const fd = openSync(filePath, fsConstants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private fsyncDirectory(directory: string) {
    if (process.platform === "win32") return;
    const fd = openSync(directory, fsConstants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private assertInsideRoot(candidate: string) {
    const resolved = path.resolve(candidate);
    const relative = path.relative(this.root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new WorkspaceBlobUnsafePathError("Workspace blob path escaped its root.");
    }
    return resolved;
  }

  private newQuarantineId(quarantineDir: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = randomUUID();
      if (
        !this.entryExists(path.join(quarantineDir, id)) &&
        !this.entryExists(this.deleteManifestPath(id))
      ) {
        return id;
      }
    }
    throw new WorkspaceBlobError("Unable to allocate a unique quarantine ID.");
  }

  private receiptPaths(receipt: WorkspaceBlobDeleteReceipt) {
    if (!receipt || receipt.status !== "staged") {
      throw new WorkspaceBlobUnsafePathError("Workspace blob delete receipt is invalid.");
    }
    this.validateLocator(receipt.locator);
    assertUuid(receipt.quarantineId, "quarantineId");
    const quarantinePath = this.assertInsideRoot(
      path.join(this.root, ".quarantine", receipt.quarantineId),
    );
    this.ensureDirectory(path.dirname(quarantinePath));
    return {
      quarantinePath,
      manifestPath: this.deleteManifestPath(receipt.quarantineId),
    };
  }

  private deleteManifestPath(quarantineId: string) {
    return this.assertInsideRoot(
      path.join(
        this.root,
        ".quarantine",
        `${quarantineId}${DELETE_MANIFEST_SUFFIX}`,
      ),
    );
  }

  private writeDeleteManifest(
    receipt: WorkspaceBlobDeleteReceipt,
    manifestPath: string,
  ) {
    const encoded = Buffer.from(
      `${JSON.stringify({
        version: 1,
        quarantineId: receipt.quarantineId,
        locator: receipt.locator,
      })}\n`,
      "utf8",
    );
    let fd: number | undefined;
    try {
      fd = openSync(
        manifestPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        OWNER_FILE_MODE,
      );
      let offset = 0;
      while (offset < encoded.length) {
        offset += writeSync(fd, encoded, offset, encoded.length - offset);
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Preserve the manifest write error.
        }
      }
      try {
        unlinkSync(manifestPath);
      } catch {
        // The manifest may not have been created.
      }
      throw error;
    }
  }

  private readDeleteManifest(
    manifestPath: string,
    expectedQuarantineId: string,
  ): WorkspaceBlobDeleteReceipt {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      throw new WorkspaceBlobIntegrityError(
        `Workspace staged-delete manifest is unreadable: ${
          error instanceof Error ? error.name : "unknown"
        }.`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WorkspaceBlobIntegrityError(
        "Workspace staged-delete manifest is invalid.",
      );
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.version !== 1 ||
      record.quarantineId !== expectedQuarantineId ||
      Object.keys(record).sort().join(",") !==
        "locator,quarantineId,version"
    ) {
      throw new WorkspaceBlobIntegrityError(
        "Workspace staged-delete manifest fields are invalid.",
      );
    }
    this.validateLocator(record.locator as WorkspaceBlobLocator);
    return {
      status: "staged",
      quarantineId: expectedQuarantineId,
      locator: record.locator as WorkspaceBlobLocator,
    };
  }

  private assertDeleteManifestMatches(
    receipt: WorkspaceBlobDeleteReceipt,
    manifestPath: string,
  ) {
    if (!this.entryExists(manifestPath)) {
      throw new WorkspaceBlobIntegrityError(
        "Workspace staged-delete manifest is missing.",
      );
    }
    const stored = this.readDeleteManifest(
      manifestPath,
      receipt.quarantineId,
    );
    if (JSON.stringify(stored.locator) !== JSON.stringify(receipt.locator)) {
      throw new WorkspaceBlobUnsafePathError(
        "Workspace blob delete receipt does not match its durable intent.",
      );
    }
  }

  private recoverIncompleteDeleteIntents() {
    const quarantineDir = path.join(this.root, ".quarantine");
    this.ensureDirectory(quarantineDir);
    for (const name of readdirSync(quarantineDir)
      .filter((entry) => entry.endsWith(DELETE_MANIFEST_SUFFIX))
      .sort()) {
      const quarantineId = name.slice(0, -DELETE_MANIFEST_SUFFIX.length);
      assertUuid(quarantineId, "quarantineId");
      const manifestPath = path.join(quarantineDir, name);
      const receipt = this.readDeleteManifest(manifestPath, quarantineId);
      const quarantinePath = path.join(quarantineDir, quarantineId);
      const target = this.authoritativePath(receipt.locator);
      const targetExists = this.entryExists(target);
      const quarantineExists = this.entryExists(quarantinePath);

      if (targetExists && quarantineExists) {
        const targetEntry = lstatSync(target);
        const quarantineEntry = lstatSync(quarantinePath);
        if (
          !targetEntry.isFile() ||
          !quarantineEntry.isFile() ||
          targetEntry.dev !== quarantineEntry.dev ||
          targetEntry.ino !== quarantineEntry.ino
        ) {
          throw new WorkspaceBlobIntegrityError(
            "Workspace staged-delete recovery found conflicting blob files.",
          );
        }
        // Stage had not durably removed the source (or restore had already
        // published it), so the authoritative copy wins.
        unlinkSync(quarantinePath);
        this.fsyncDirectory(quarantineDir);
      }

      if (targetExists || !quarantineExists) {
        if (this.entryExists(manifestPath)) unlinkSync(manifestPath);
        this.fsyncDirectory(quarantineDir);
      }
      // target missing + quarantine present is a completed staged delete.
      // Keep both entries for DB-aware startup reconciliation.
    }
  }

  private isAlreadyExistsError(error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === "EEXIST";
  }
}

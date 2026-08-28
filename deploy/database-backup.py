#!/usr/bin/env python3

import datetime as dt
import gzip
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.parse


CRITICAL_TABLES = (
    "tenants",
    "users",
    "products",
    "inventory_balances",
    "inventory_movements",
    "sales",
    "sale_lines",
    "audit_events",
    "privacy_policies",
    "privacy_legal_holds",
    "privacy_requests",
)
SAFE_ENVIRONMENTS = {"dev", "prod"}
SAFE_RESTORE_PREFIX = re.compile(r"^uinventario_restore_drill_(dev|prod)_[0-9]{14}_[a-z0-9]{1,24}$")
_SSL_MODE_SUPPORT: dict[str, bool] = {}


class BackupError(RuntimeError):
    pass


def structured(event: str, **details: object) -> None:
    print(json.dumps({"event": event, **details}, separators=(",", ":")), flush=True)


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise BackupError(f"Missing required configuration: {name}")
    return value


def connection() -> dict[str, object]:
    value = required("DATABASE_URL")
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"mysql", "mysql2"} or not parsed.hostname or not parsed.username:
        raise BackupError("DATABASE_URL must be a complete MySQL URL")
    database = urllib.parse.unquote(parsed.path.lstrip("/"))
    if not database or not re.fullmatch(r"[A-Za-z0-9_$-]{1,64}", database):
        raise BackupError("DATABASE_URL database name is invalid")
    query = urllib.parse.parse_qs(parsed.query)
    return {
        "host": parsed.hostname,
        "port": parsed.port or 3306,
        "user": urllib.parse.unquote(parsed.username),
        "password": urllib.parse.unquote(parsed.password or ""),
        "database": database,
        "ssl_mode": query.get("ssl-mode", query.get("ssl_mode", [""]))[0].upper(),
    }


def mysql_environment(config: dict[str, object]) -> dict[str, str]:
    environment = os.environ.copy()
    environment["MYSQL_PWD"] = str(config["password"])
    return environment


def client_supports_ssl_mode(command: str) -> bool:
    if command in _SSL_MODE_SUPPORT:
        return _SSL_MODE_SUPPORT[command]
    result = subprocess.run(
        [command, "--help"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    _SSL_MODE_SUPPORT[command] = "--ssl-mode" in result.stdout
    return _SSL_MODE_SUPPORT[command]


def client_args(command: str, config: dict[str, object], database: str | None = None) -> list[str]:
    args = [
        command,
        f"--host={config['host']}",
        f"--port={config['port']}",
        f"--user={config['user']}",
        "--protocol=TCP",
    ]
    ssl_mode = str(config["ssl_mode"])
    if ssl_mode:
        if client_supports_ssl_mode(command):
            args.append(f"--ssl-mode={ssl_mode}")
        elif ssl_mode != "DISABLED":
            args.append("--ssl")
            if ssl_mode in {"VERIFY_CA", "VERIFY_IDENTITY"}:
                args.append("--ssl-verify-server-cert")
    if database:
        args.append(f"--database={database}")
    return args


def mysql_query(config: dict[str, object], sql: str, database: str | None = None) -> str:
    result = subprocess.run(
        client_args("mysql", config, database)
        + ["--batch", "--skip-column-names", "--raw", "--execute", sql],
        env=mysql_environment(config),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise BackupError("MySQL validation command failed")
    return result.stdout.strip()


def quote_identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_$-]{1,64}", value):
        raise BackupError("Unsafe MySQL identifier")
    return f"`{value.replace('`', '``')}`"


def source_snapshot(config: dict[str, object], database: str) -> dict[str, object]:
    table_output = mysql_query(
        config,
        "SELECT TABLE_NAME FROM information_schema.TABLES "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
        database,
    )
    tables = [line for line in table_output.splitlines() if line]
    counts: dict[str, int] = {}
    for table in CRITICAL_TABLES:
        if table in tables:
            counts[table] = int(
                mysql_query(config, f"SELECT COUNT(*) FROM {quote_identifier(table)}", database)
            )
    migration = {"count": 0, "latest": None}
    if "migrations" in tables:
        output = mysql_query(
            config,
            "SELECT COUNT(*), COALESCE(MAX(CONCAT(timestamp, ':', name)), '') FROM migrations",
            database,
        )
        count, latest = (output.split("\t", 1) + [""])[:2]
        migration = {"count": int(count), "latest": latest or None}
    return {"tables": tables, "criticalCounts": counts, "migrations": migration}


def dump_database(config: dict[str, object], target: pathlib.Path) -> None:
    args = client_args("mysqldump", config) + [
        "--single-transaction",
        "--quick",
        "--skip-lock-tables",
        "--routines",
        "--triggers",
        "--events",
        "--hex-blob",
        "--no-tablespaces",
        str(config["database"]),
    ]
    process = subprocess.Popen(
        args,
        env=mysql_environment(config),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdout is not None
    with target.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            while chunk := process.stdout.read(1024 * 1024):
                compressed.write(chunk)
    _, _ = process.communicate()
    if process.returncode != 0:
        target.unlink(missing_ok=True)
        raise BackupError("mysqldump failed")


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def gcloud(*args: str, capture: bool = False) -> str:
    result = subprocess.run(
        ["gcloud", *args],
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        detail = " ".join(result.stderr.strip().split())[-500:]
        raise BackupError(f"Cloud Storage operation failed: {detail or 'unknown error'}")
    return result.stdout.strip() if capture else ""


def safe_run_id() -> str:
    raw = os.environ.get("CLOUD_RUN_EXECUTION", "manual").lower()
    return re.sub(r"[^a-z0-9]", "", raw)[-24:] or "manual"


def backup() -> None:
    environment = required("DEPLOY_ENV")
    if environment not in SAFE_ENVIRONMENTS:
        raise BackupError("DEPLOY_ENV must be dev or prod")
    bucket = required("BACKUP_BUCKET")
    config = connection()
    before = source_snapshot(config, str(config["database"]))
    now = dt.datetime.now(dt.timezone.utc)
    timestamp = now.strftime("%Y%m%dT%H%M%SZ")
    attempt = re.sub(r"[^0-9]", "", os.environ.get("CLOUD_RUN_TASK_ATTEMPT", "0")) or "0"
    name = f"database/{environment}/{timestamp}-{safe_run_id()}-a{attempt}.sql.gz"
    uri = f"gs://{bucket}/{name}"
    with tempfile.TemporaryDirectory(prefix="uinventario-backup-") as directory:
        dump_path = pathlib.Path(directory) / "database.sql.gz"
        metadata_path = pathlib.Path(directory) / "database.sql.gz.json"
        dump_database(config, dump_path)
        after = source_snapshot(config, str(config["database"]))
        if before != after:
            raise BackupError("Source changed during backup; retrying preserves consistency")
        metadata = {
            "schemaVersion": 1,
            "environment": environment,
            "createdAt": now.isoformat(),
            "object": uri,
            "sha256": sha256(dump_path),
            "compressedBytes": dump_path.stat().st_size,
            "source": before,
        }
        metadata_path.write_text(json.dumps(metadata, sort_keys=True), encoding="utf-8")
        gcloud("storage", "cp", str(dump_path), uri)
        gcloud("storage", "cp", str(metadata_path), f"{uri}.json")
    structured(
        "database_backup_completed",
        environment=environment,
        object=uri,
        compressedBytes=metadata["compressedBytes"],
        tableCount=len(before["tables"]),
    )


def latest_metadata_uri(bucket: str, environment: str) -> str:
    output = gcloud(
        "storage",
        "ls",
        f"gs://{bucket}/database/{environment}/*.sql.gz.json",
        capture=True,
    )
    candidates = sorted(line.strip() for line in output.splitlines() if line.strip())
    if not candidates:
        raise BackupError("No completed backup metadata is available")
    return candidates[-1]


def restore_dump(config: dict[str, object], database: str, source: pathlib.Path) -> None:
    process = subprocess.Popen(
        client_args("mysql", config, database),
        env=mysql_environment(config),
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    assert process.stdin is not None
    with gzip.open(source, "rb") as decompressed:
        while chunk := decompressed.read(1024 * 1024):
            process.stdin.write(chunk)
    process.stdin.close()
    process.stdin = None
    _, _ = process.communicate()
    if process.returncode != 0:
        raise BackupError("MySQL restore failed")


def restore_drill() -> None:
    environment = required("DEPLOY_ENV")
    if environment not in SAFE_ENVIRONMENTS:
        raise BackupError("DEPLOY_ENV must be dev or prod")
    bucket = required("BACKUP_BUCKET")
    config = connection()
    metadata_uri = latest_metadata_uri(bucket, environment)
    with tempfile.TemporaryDirectory(prefix="uinventario-restore-") as directory:
        dump_path = pathlib.Path(directory) / "database.sql.gz"
        metadata_path = pathlib.Path(directory) / "database.sql.gz.json"
        gcloud("storage", "cp", metadata_uri, str(metadata_path))
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("schemaVersion") != 1 or metadata.get("environment") != environment:
            raise BackupError("Backup metadata is incompatible with this environment")
        object_uri = str(metadata.get("object", ""))
        expected_prefix = f"gs://{bucket}/database/{environment}/"
        if not object_uri.startswith(expected_prefix) or not object_uri.endswith(".sql.gz"):
            raise BackupError("Backup metadata references an unsafe object")
        gcloud("storage", "cp", object_uri, str(dump_path))
        if sha256(dump_path) != metadata.get("sha256"):
            raise BackupError("Backup checksum does not match metadata")
        timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S")
        restore_database = f"uinventario_restore_drill_{environment}_{timestamp}_{safe_run_id()[:12]}"
        if (
            not SAFE_RESTORE_PREFIX.fullmatch(restore_database)
            or restore_database == config["database"]
        ):
            raise BackupError("Restore target is not isolated")
        quoted = quote_identifier(restore_database)
        created = False
        try:
            mysql_query(
                config,
                f"CREATE DATABASE {quoted} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
            )
            created = True
            restore_dump(config, restore_database, dump_path)
            restored = source_snapshot(config, restore_database)
            expected = metadata.get("source")
            if restored != expected:
                raise BackupError("Restored schema or critical row counts do not match the backup")
        finally:
            if created:
                if not SAFE_RESTORE_PREFIX.fullmatch(restore_database):
                    raise BackupError("Refusing to remove an unsafe restore target")
                mysql_query(config, f"DROP DATABASE {quoted}")
    structured(
        "database_restore_drill_completed",
        environment=environment,
        object=object_uri,
        tableCount=len(restored["tables"]),
        criticalTables=len(restored["criticalCounts"]),
    )


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in {"backup", "restore-drill"}:
        raise BackupError("Usage: database-backup.py <backup|restore-drill>")
    if sys.argv[1] == "backup":
        backup()
    else:
        restore_drill()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        structured(
            "database_backup_operation_failed",
            error=type(error).__name__,
            message=str(error) if isinstance(error, BackupError) else "Unexpected operation failure",
        )
        sys.exit(1)

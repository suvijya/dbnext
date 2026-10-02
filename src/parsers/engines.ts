/**
 * Database-engine detector: reads configuration files (docker compose, dependency manifests, env
 * *examples* and framework config) and reports which database management systems a project uses.
 *
 * It NEVER reads real `.env` files and NEVER puts secrets, hosts, users or passwords in the hint
 * `detail`: only image names, package names, URL schemes and adapter / driver keywords.
 *
 * Pure TypeScript, no Node APIs (runs in the desktop and the web extension host).
 */

import type { EngineHint, EngineId, SourceFile } from '../core/model';
import { baseName } from '../core/parser';
import { globToRegExp, type EngineDetector } from '../core/scan';

const FILE_PATTERNS: readonly string[] = [
  '**/docker-compose*.{yml,yaml}',
  '**/compose*.{yml,yaml}',
  '**/package.json',
  '**/requirements*.txt',
  '**/pyproject.toml',
  '**/Pipfile',
  '**/Gemfile',
  '**/composer.json',
  '**/go.mod',
  '**/pom.xml',
  '**/build.gradle',
  '**/build.gradle.kts',
  '**/*.csproj',
  '**/Cargo.toml',
  '**/mix.exs',
  '**/.env.example',
  '**/.env.sample',
  '**/.env.template',
  '**/.env.dist',
  '**/config/database.yml',
  '**/application*.{properties,yml,yaml}',
  '**/appsettings*.json',
  '**/settings.py',
  '**/settings/*.py',
  '**/config/database.php',
];

const pathMatcher = globToRegExp(FILE_PATTERNS);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Mapping tables
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Maps a container image reference (`postgres:16`, `bitnami/postgresql`) to an engine. */
function imageEngine(ref: string): EngineId | undefined {
  let img = ref.trim().replace(/^["']|["']$/g, '');
  if (!img) return undefined;
  const at = img.indexOf('@');
  if (at >= 0) img = img.slice(0, at);
  const slash = img.lastIndexOf('/');
  const colon = img.lastIndexOf(':');
  const repo = (colon > slash ? img.slice(0, colon) : img).toLowerCase();
  const seg = repo.split('/').pop() ?? repo;

  // Database GUI / admin tools never count as an engine.
  if (/(adminer|pgadmin|phpmyadmin|mongo-express|redis-?commander|redisinsight|dpage|cloudbeaver)/.test(repo)) {
    return undefined;
  }

  if (repo.includes('timescaledb') || repo.includes('postgis') || (repo.includes('supabase') && repo.includes('postgres'))) {
    return 'postgresql';
  }
  if (repo.includes('cockroach')) return 'cockroachdb';
  if (seg === 'postgres' || seg === 'postgresql' || repo.endsWith('/postgres') || repo.endsWith('/postgresql')) return 'postgresql';
  if (repo.includes('mssql') || repo.includes('sqlserver')) return 'sqlserver';
  if (repo.includes('cosmos')) return 'cosmosdb';
  if (repo.includes('oracle') || repo.includes('database/free') || repo.includes('database/express')) return 'oracle';
  if (repo.includes('scylla')) return 'cassandra';
  if (seg === 'cassandra' || repo.endsWith('/cassandra')) return 'cassandra';
  if (repo.includes('dynamodb')) return 'dynamodb';
  if (seg === 'mariadb' || repo.endsWith('/mariadb')) return 'mariadb';
  if (seg === 'mysql' || repo.endsWith('/mysql') || seg === 'mysql-server') return 'mysql';
  if (seg === 'neo4j' || repo.endsWith('/neo4j')) return 'neo4j';
  if (seg.includes('opensearch') || seg === 'elasticsearch' || repo.includes('/elasticsearch')) return 'elasticsearch';
  if (repo.includes('clickhouse')) return 'clickhouse';
  if (seg === 'valkey' || repo.includes('valkey')) return 'redis';
  if (seg === 'redis' || repo.endsWith('/redis')) return 'redis';
  if (seg === 'mongo' || seg === 'mongodb' || repo.endsWith('/mongo') || repo.endsWith('/mongodb')) return 'mongodb';
  if (repo.includes('duckdb')) return 'duckdb';
  return undefined;
}

/** Maps a dependency / package / artifact name to an engine. */
function depEngine(raw: string): EngineId | undefined {
  let n = raw.trim().toLowerCase();
  if (!n) return undefined;
  n = n.replace(/\/v\d+$/, ''); // Go module major-version suffix
  const seg = n.split('/').pop() ?? n;

  // PostgreSQL
  if (['pg', 'postgres', 'postgresql', 'psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg', 'tokio-postgres', 'postgrex'].includes(n)) return 'postgresql';
  if (n === '@neondatabase/serverless' || n === '@vercel/postgres') return 'postgresql';
  if (n === 'org.postgresql' || n.startsWith('npgsql')) return 'postgresql';
  if (n.includes('jackc/pgx') || n.endsWith('lib/pq')) return 'postgresql';
  // CockroachDB
  if (n.includes('cockroach')) return 'cockroachdb';
  // MySQL
  if (['mysql', 'mysql2', 'mysqlclient', 'pymysql', 'myxql', 'mysql.data'].includes(n)) return 'mysql';
  if (n.startsWith('mysql-connector') || n.includes('go-sql-driver/mysql') || (n.includes('pomelo') && n.includes('mysql'))) return 'mysql';
  // MariaDB
  if (n === 'mariadb' || n.includes('mariadb-connector') || n.includes('org.mariadb')) return 'mariadb';
  // SQLite
  if (['sqlite3', 'better-sqlite3', 'rusqlite', 'ecto_sqlite3', 'sqlite-jdbc'].includes(n)) return 'sqlite';
  if (n === '@libsql/client' || n.includes('go-sqlite3') || n === 'modernc.org/sqlite') return 'sqlite';
  if (n === 'microsoft.data.sqlite' || n.endsWith('.entityframeworkcore.sqlite')) return 'sqlite';
  // SQL Server
  if (['mssql', 'tedious', 'pymssql', 'mssql-jdbc'].includes(n)) return 'sqlserver';
  if (n.includes('go-mssqldb') || n === 'microsoft.data.sqlclient' || n.endsWith('.entityframeworkcore.sqlserver')) return 'sqlserver';
  // Oracle
  if (['oracledb', 'cx_oracle', 'godror'].includes(n)) return 'oracle';
  if (n.startsWith('ojdbc') || n.startsWith('oracle.manageddataaccess') || n.includes('godror')) return 'oracle';
  // MongoDB
  if (['mongodb', 'mongoose', 'pymongo', 'motor', 'mongoengine', 'mongoid', 'org.mongodb', 'mongodb.driver'].includes(n)) return 'mongodb';
  if (n.includes('mongo-driver') || n.includes('mongodb.org')) return 'mongodb';
  // Redis
  if (['redis', 'ioredis', 'go-redis', 'jedis', 'lettuce', 'redix', 'stackexchange.redis'].includes(n)) return 'redis';
  if (n.includes('go-redis/redis') || n.includes('redis/go-redis')) return 'redis';
  // Cassandra
  if (['cassandra-driver', 'gocql', 'datastax'].includes(n) || n.includes('gocql') || n.includes('datastax')) return 'cassandra';
  // DynamoDB
  if (n === 'dynamoose' || n === '@aws-sdk/client-dynamodb') return 'dynamodb';
  if (n.includes('aws-sdk-go') && n.includes('dynamodb')) return 'dynamodb';
  // Firestore
  if (n === '@google-cloud/firestore' || n === 'google-cloud-firestore') return 'firestore';
  // Cosmos DB
  if (n === '@azure/cosmos' || n === 'azure-cosmos' || n === 'microsoft.azure.cosmos') return 'cosmosdb';
  // Neo4j
  if (['neo4j', 'neo4j-driver', 'neo4j-go-driver', 'org.neo4j.driver'].includes(n) || n.includes('neo4j')) return 'neo4j';
  // Elasticsearch
  if (n === '@elastic/elasticsearch' || n === 'elasticsearch' || n === 'go-elasticsearch' || n.includes('elasticsearch')) return 'elasticsearch';
  // ClickHouse
  if (['clickhouse-driver', 'clickhouse-connect', 'clickhouse-go'].includes(n) || n === '@clickhouse/client' || n.includes('clickhouse')) return 'clickhouse';
  // DuckDB
  if (n === 'duckdb' || seg === 'duckdb') return 'duckdb';
  // Snowflake
  if (n === 'snowflake-sdk' || n === 'snowflake-connector-python' || n.includes('snowflake')) return 'snowflake';
  // BigQuery
  if (n === '@google-cloud/bigquery' || n === 'google-cloud-bigquery' || n.includes('bigquery')) return 'bigquery';
  // H2
  if (n === 'com.h2database' || seg === 'h2') return 'h2';

  return undefined;
}

/** Connection-string URL schemes. The regex matches ONLY the scheme (never a host or credentials). */
const SCHEMES: readonly [RegExp, EngineId][] = [
  [/jdbc:postgresql:/i, 'postgresql'],
  [/postgres(?:ql)?:\/\//i, 'postgresql'],
  [/cockroachdb:\/\//i, 'cockroachdb'],
  [/jdbc:mysql:/i, 'mysql'],
  [/mysql:\/\//i, 'mysql'],
  [/jdbc:mariadb:/i, 'mariadb'],
  [/mariadb:\/\//i, 'mariadb'],
  [/jdbc:sqlserver:/i, 'sqlserver'],
  [/sqlserver:\/\//i, 'sqlserver'],
  [/mongodb(?:\+srv)?:\/\//i, 'mongodb'],
  [/rediss?:\/\//i, 'redis'],
  [/clickhouse(?:\+\w+)?:\/\//i, 'clickhouse'],
  [/jdbc:h2:/i, 'h2'],
  [/jdbc:oracle:/i, 'oracle'],
  [/sqlite:/i, 'sqlite'],
];

const ADAPTERS: Readonly<Record<string, EngineId>> = {
  postgresql: 'postgresql',
  postgres: 'postgresql',
  postgis: 'postgresql',
  cockroachdb: 'cockroachdb',
  mysql: 'mysql',
  mysql2: 'mysql',
  trilogy: 'mysql',
  mariadb: 'mariadb',
  sqlite3: 'sqlite',
  sqlite: 'sqlite',
  sqlserver: 'sqlserver',
  sqlsrv: 'sqlserver',
  oracle_enhanced: 'oracle',
  oracle: 'oracle',
};

/** Laravel / PHP connection driver names (`DB_CONNECTION=`, `'driver' => '…'`). */
const PHP_DRIVERS: Readonly<Record<string, EngineId>> = {
  mysql: 'mysql',
  mariadb: 'mariadb',
  pgsql: 'postgresql',
  sqlite: 'sqlite',
  sqlsrv: 'sqlserver',
};

const DJANGO_BACKENDS: Readonly<Record<string, EngineId>> = {
  postgresql: 'postgresql',
  postgresql_psycopg2: 'postgresql',
  postgis: 'postgresql',
  mysql: 'mysql',
  sqlite3: 'sqlite',
  oracle: 'oracle',
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Scanners
// ─────────────────────────────────────────────────────────────────────────────────────────────

type Add = (engine: EngineId, line: number, detail: string) => void;

/** Splits text into lines (handling CRLF) and calls `fn` with the 0-based line number. */
function eachLine(text: string, fn: (line: string, lineNo: number) => void): void {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    fn(l.charCodeAt(l.length - 1) === 13 ? l.slice(0, -1) : l, i);
  }
}

/** Only `[\w.-]` identifier keys are echoed back; everything else becomes a generic phrase. */
function safeKey(line: string): string | undefined {
  const m = /^\s*(?:export\s+)?([\w.-]{1,60})\s*[:=]/.exec(line);
  return m ? m[1] : undefined;
}

/**
 * Resolves docker-compose variable substitution in an image reference so default tags are seen:
 * `${PG_IMAGE:-postgres:16}` → `postgres:16`, `postgres:${PG_TAG:-16}` → `postgres:16`.
 * `${VAR}` / `${VAR:?err}` / `$VAR` have no usable default and collapse to nothing.
 */
function resolveComposeImage(ref: string): string {
  return ref
    .replace(/\$\{([A-Za-z_]\w*):?-([^}]*)\}/g, (_m, _v, def: string) => def) // ${VAR:-def} / ${VAR-def}
    .replace(/\$\{[^}]*\}/g, '') // ${VAR}, ${VAR:?err}, ${VAR:+alt} → unknown
    .replace(/\$[A-Za-z_]\w*/g, '') // $VAR
    .trim();
}

function scanCompose(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    const m = /^\s*image:\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (!m) return;
    const image = resolveComposeImage(m[1].replace(/^["']|["']$/g, '').trim());
    if (!image) return;
    const engine = imageEngine(image);
    if (engine) add(engine, no, `docker compose image "${image}"`);
  });
}

/** Scans quoted JSON keys (`"pg": "^8"`); the surrounding structure does not matter. */
function scanJsonKeys(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    for (const m of line.matchAll(/"([^"]+)"\s*:/g)) {
      const engine = depEngine(m[1]);
      if (engine) add(engine, no, `dependency "${m[1]}"`);
    }
  });
}

function scanCsproj(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    for (const m of line.matchAll(/<PackageReference\s+Include\s*=\s*"([^"]+)"/g)) {
      const engine = depEngine(m[1]);
      if (engine) add(engine, no, `dependency "${m[1]}"`);
    }
  });
}

function scanGoMod(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    const l = line.replace(/^\s*require\s+/, '');
    const m = /^\s*([^\s()]+)\s+v\d/.exec(l);
    if (!m) return;
    const engine = depEngine(m[1]);
    if (engine) add(engine, no, `dependency "${m[1]}"`);
  });
}

function scanGemfile(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    const m = /^\s*gem\s+["']([^"']+)["']/.exec(line);
    if (!m) return;
    const engine = depEngine(m[1]);
    if (engine) add(engine, no, `dependency "${m[1]}"`);
  });
}

function scanMix(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    for (const m of line.matchAll(/\{\s*:([a-z0-9_]+)/g)) {
      const engine = depEngine(m[1]);
      if (engine) add(engine, no, `dependency "${m[1]}"`);
    }
  });
}

function scanRequirements(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    if (/^\s*[#-]/.test(line)) return;
    const m = /^\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)/.exec(line);
    if (!m) return;
    const engine = depEngine(m[1]);
    if (engine) add(engine, no, `dependency "${m[1]}"`);
  });
}

/** TOML sections (`[dependencies]`, `[packages]`, `[tool.poetry.dependencies]`). */
function scanTomlDeps(text: string, add: Add, sectionRe: RegExp): void {
  let inSection = false;
  eachLine(text, (line, no) => {
    const section = /^\s*\[(.+?)\]/.exec(line);
    if (section) {
      const name = section[1].trim();
      inSection = sectionRe.test(name);
      // A dotted dependency table such as `[dependencies.redis]` names the dependency directly.
      const dotted = /^(?:.*\.)?(?:dependencies|packages|dev-packages)\.([A-Za-z0-9_.-]+)$/.exec(name);
      if (dotted) {
        const engine = depEngine(dotted[1]);
        if (engine) add(engine, no, `dependency "${dotted[1]}"`);
      }
      return;
    }
    if (!inSection) return;
    const m = /^\s*["']?([A-Za-z0-9_.-]+)["']?\s*=/.exec(line);
    if (!m || m[1].toLowerCase() === 'python') return;
    const engine = depEngine(m[1]);
    if (engine) add(engine, no, `dependency "${m[1]}"`);
  });
}

/** PEP 621 style `dependencies = ["psycopg2>=2.9", …]` (quoted requirement specifiers). */
function scanQuotedRequirements(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    for (const m of line.matchAll(/["']([A-Za-z0-9_.-]+)\s*(?:[<>=!~;[(]|["'])/g)) {
      const engine = depEngine(m[1]);
      if (engine) add(engine, no, `dependency "${m[1]}"`);
    }
  });
}

function scanMavenGradle(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    for (const m of line.matchAll(/<(?:groupId|artifactId)>([^<]+)<\//g)) {
      const engine = depEngine(m[1].trim());
      if (engine) add(engine, no, `dependency "${m[1].trim()}"`);
    }
    for (const m of line.matchAll(/["']([\w.-]+):([\w.-]+)(?::[\w.${}-]*)?["']/g)) {
      const engine = depEngine(m[1]) ?? depEngine(m[2]);
      if (engine) add(engine, no, `dependency "${m[1]}:${m[2]}"`);
    }
  });
}

function scanUrlSchemes(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    for (const [re, engine] of SCHEMES) {
      const m = re.exec(line);
      if (!m) continue;
      const scheme = m[0].toLowerCase();
      const key = safeKey(line);
      add(engine, no, key ? `${key} uses ${scheme}` : `connection URL uses ${scheme}`);
      break; // one scheme per line is enough
    }
  });
}

function scanRailsAdapter(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    const m = /^\s*adapter:\s*["']?([a-z0-9_]+)/i.exec(line);
    if (!m) return;
    const engine = ADAPTERS[m[1].toLowerCase()];
    if (engine) add(engine, no, `database.yml adapter "${m[1]}"`);
  });
}

function scanPhpDriver(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    for (const m of line.matchAll(/['"]driver['"]\s*=>\s*['"]([a-z]+)['"]/gi)) {
      const engine = PHP_DRIVERS[m[1].toLowerCase()];
      if (engine) add(engine, no, `database.php driver "${m[1]}"`);
    }
    const def = /['"]default['"]\s*=>\s*env\(\s*['"][^'"]+['"]\s*,\s*['"]([a-z]+)['"]/i.exec(line);
    if (def) {
      const engine = PHP_DRIVERS[def[1].toLowerCase()];
      if (engine) add(engine, no, `database.php default "${def[1]}"`);
    }
  });
}

function scanLaravelEnv(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    const m = /^\s*DB_CONNECTION\s*=\s*["']?([a-z]+)/i.exec(line);
    if (!m) return;
    const engine = PHP_DRIVERS[m[1].toLowerCase()];
    if (engine) add(engine, no, `DB_CONNECTION=${m[1]}`);
  });
}

function scanDjango(text: string, add: Add): void {
  eachLine(text, (line, no) => {
    for (const m of line.matchAll(/django\.db\.backends\.(\w+)/g)) {
      const engine = DJANGO_BACKENDS[m[1].toLowerCase()];
      if (engine) add(engine, no, `Django ENGINE "django.db.backends.${m[1]}"`);
    }
    if (/django_cockroachdb/.test(line)) add('cockroachdb', no, 'Django ENGINE "django_cockroachdb"');
    if (/\bdjongo\b/.test(line)) add('mongodb', no, 'Django ENGINE "djongo"');
    if (/sql_server\.pyodbc|mssql_backend|['"]mssql['"]/.test(line)) add('sqlserver', no, 'Django ENGINE "mssql"');
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Detector
// ─────────────────────────────────────────────────────────────────────────────────────────────

function detect(file: SourceFile): EngineHint[] {
  const base = baseName(file.path).toLowerCase();
  const path = file.path.toLowerCase();

  // Defence in depth: never look at a real `.env` file (filePatterns already exclude it).
  if (base === '.env' || (base.startsWith('.env') && !/\.(example|sample|template|dist)$/.test(base))) return [];

  const hints: EngineHint[] = [];
  const add: Add = (engine, line, detail) => hints.push({ engine, line, detail });
  const text = file.text;

  if (/^(docker-compose|compose).*\.ya?ml$/.test(base)) scanCompose(text, add);
  else if (base === 'package.json' || base === 'composer.json') scanJsonKeys(text, add);
  else if (/^appsettings.*\.json$/.test(base)) scanUrlSchemes(text, add);
  else if (base.endsWith('.csproj')) scanCsproj(text, add);
  else if (base === 'go.mod') scanGoMod(text, add);
  else if (base === 'cargo.toml') scanTomlDeps(text, add, /dependencies$/);
  else if (base === 'mix.exs') scanMix(text, add);
  else if (base === 'gemfile') scanGemfile(text, add);
  else if (/^requirements.*\.txt$/.test(base)) scanRequirements(text, add);
  else if (base === 'pipfile') scanTomlDeps(text, add, /^(packages|dev-packages)$/);
  else if (base === 'pyproject.toml') {
    scanTomlDeps(text, add, /(^|\.)dependencies$/);
    scanQuotedRequirements(text, add);
  } else if (base === 'pom.xml' || base === 'build.gradle' || base === 'build.gradle.kts') scanMavenGradle(text, add);
  else if (base === 'database.yml') {
    scanRailsAdapter(text, add);
    scanUrlSchemes(text, add);
  } else if (base === 'database.php') {
    scanPhpDriver(text, add);
    scanUrlSchemes(text, add);
  } else if (/^application.*\.(properties|ya?ml)$/.test(base)) scanUrlSchemes(text, add);
  else if (base === 'settings.py' || /(^|\/)settings\/[^/]+\.py$/.test(path)) {
    scanDjango(text, add);
    scanUrlSchemes(text, add);
  } else if (/^\.env\.(example|sample|template|dist)$/.test(base)) {
    scanLaravelEnv(text, add);
    scanUrlSchemes(text, add);
  }

  // One hint per (engine, line).
  const seen = new Set<string>();
  const out: EngineHint[] = [];
  for (const h of hints) {
    const k = `${h.engine}|${h.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

export const engineDetector: EngineDetector = {
  filePatterns: FILE_PATTERNS,
  matches: (p) => pathMatcher.test(p),
  detect,
};

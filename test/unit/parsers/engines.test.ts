import { describe, expect, it } from 'vitest';
import type { EngineHint, SourceFile } from '../../../src/core/model';
import { globToRegExp } from '../../../src/core/scan';
import { engineDetector } from '../../../src/parsers/engines';

const detect = (path: string, text: string): EngineHint[] => engineDetector.detect({ path, text } as SourceFile);
const engines = (hints: EngineHint[]): string[] => [...new Set(hints.map((h) => h.engine))].sort();

describe('engine detector matches()', () => {
  it('agrees with filePatterns and never matches a real .env file', () => {
    const re = globToRegExp(engineDetector.filePatterns);
    for (const p of [
      'docker-compose.yml',
      'services/api/docker-compose.prod.yaml',
      'compose.yaml',
      'package.json',
      'backend/go.mod',
      'Cargo.toml',
      'requirements.txt',
      'requirements-dev.txt',
      'Pipfile',
      'pyproject.toml',
      'Gemfile',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'src/App.csproj',
      'mix.exs',
      '.env.example',
      'config/database.yml',
      'config/database.php',
      'src/main/resources/application.properties',
      'appsettings.Development.json',
      'myapp/settings.py',
      'config/settings/base.py',
    ]) {
      expect(engineDetector.matches(p), p).toBe(true);
      expect(re.test(p), p).toBe(true);
    }
    for (const p of ['.env', '.env.local', 'random.txt', 'src/main.rs', 'README.md', 'index.ts']) {
      expect(engineDetector.matches(p), p).toBe(false);
    }
  });
});

describe('docker compose images', () => {
  const compose = [
    'version: "3.8"',
    'services:',
    '  db:',
    '    image: postgres:16',
    '  cache:',
    '    image: "redis:7"',
    '  admin:',
    '    image: adminer:4',
    '  search:',
    '    image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0',
  ].join('\n');

  it('maps images to engines, excludes admin tools, uses 0-based lines', () => {
    const hints = detect('docker-compose.yml', compose);
    expect(engines(hints)).toEqual(['elasticsearch', 'postgresql', 'redis']);
    expect(hints.find((h) => h.engine === 'postgresql')).toEqual({ engine: 'postgresql', line: 3, detail: 'docker compose image "postgres:16"' });
    expect(hints.some((h) => h.detail.includes('adminer'))).toBe(false);
  });

  it('recognises postgres-compatible and other engine images', () => {
    const cases: [string, string][] = [
      ['timescale/timescaledb:latest-pg16', 'postgresql'],
      ['postgis/postgis:16-3.4', 'postgresql'],
      ['supabase/postgres:15.1', 'postgresql'],
      ['cockroachdb/cockroach:v23.1', 'cockroachdb'],
      ['mariadb:11', 'mariadb'],
      ['mysql:8', 'mysql'],
      ['mcr.microsoft.com/mssql/server:2022-latest', 'sqlserver'],
      ['gvenzl/oracle-xe:21', 'oracle'],
      ['scylladb/scylla', 'cassandra'],
      ['amazon/dynamodb-local', 'dynamodb'],
      ['neo4j:5', 'neo4j'],
      ['clickhouse/clickhouse-server', 'clickhouse'],
      ['valkey/valkey:8', 'redis'],
      ['mongo:7', 'mongodb'],
      ['bitnami/postgresql:16', 'postgresql'],
    ];
    for (const [image, engine] of cases) {
      const hints = detect('compose.yaml', `services:\n  db:\n    image: ${image}`);
      expect(engines(hints), image).toEqual([engine]);
    }
  });
});

describe('dependency manifests', () => {
  it('package.json', () => {
    const pkg = JSON.stringify({ dependencies: { pg: '^8', ioredis: '^5', mongoose: '^8', express: '^4' } }, null, 2);
    expect(engines(detect('package.json', pkg))).toEqual(['mongodb', 'postgresql', 'redis']);
  });

  it('go.mod', () => {
    const go = `module example.com/app
go 1.22
require (
	github.com/lib/pq v1.10.9
	github.com/go-redis/redis/v8 v8.11.5
	go.mongodb.org/mongo-driver v1.13.1
)`;
    expect(engines(detect('go.mod', go))).toEqual(['mongodb', 'postgresql', 'redis']);
  });

  it('Cargo.toml', () => {
    const cargo = `[package]
name = "app"
[dependencies]
tokio-postgres = "0.7"
rusqlite = { version = "0.31" }
redis = "0.25"
serde = "1"`;
    expect(engines(detect('Cargo.toml', cargo))).toEqual(['postgresql', 'redis', 'sqlite']);
  });

  it('requirements.txt (skips comments and options)', () => {
    const req = `psycopg2-binary==2.9.9
redis>=4.0
# a comment
pymongo
-r base.txt`;
    expect(engines(detect('requirements.txt', req))).toEqual(['mongodb', 'postgresql', 'redis']);
  });

  it('Gemfile', () => {
    const gem = `source 'https://rubygems.org'
gem 'rails'
gem 'pg', '~> 1.5'
gem 'redis'`;
    expect(engines(detect('Gemfile', gem))).toEqual(['postgresql', 'redis']);
  });

  it('pom.xml and build.gradle', () => {
    const pom = `<project><dependencies>
<dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId></dependency>
<dependency><groupId>com.h2database</groupId><artifactId>h2</artifactId></dependency>
</dependencies></project>`;
    expect(engines(detect('pom.xml', pom))).toEqual(['h2', 'postgresql']);
    const gradle = `dependencies {
    implementation 'org.postgresql:postgresql:42.6.0'
    runtimeOnly "com.mysql:mysql-connector-j:8.3.0"
}`;
    expect(engines(detect('build.gradle', gradle))).toEqual(['mysql', 'postgresql']);
  });

  it('.csproj and mix.exs and Pipfile and pyproject.toml', () => {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
<PackageReference Include="Npgsql" Version="8.0.0" />
<PackageReference Include="StackExchange.Redis" Version="2.7.0" />
<PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="8.0.0" />
</ItemGroup></Project>`;
    expect(engines(detect('App.csproj', csproj))).toEqual(['postgresql', 'redis', 'sqlite']);

    const mix = `defp deps do
  [
    {:ecto_sql, "~> 3.11"},
    {:postgrex, ">= 0.0.0"},
    {:redix, "~> 1.3"}
  ]
end`;
    expect(engines(detect('mix.exs', mix))).toEqual(['postgresql', 'redis']);

    const pipfile = `[packages]
psycopg2 = "*"
redis = "*"
[dev-packages]
pytest = "*"`;
    expect(engines(detect('Pipfile', pipfile))).toEqual(['postgresql', 'redis']);

    const pyproject = `[tool.poetry.dependencies]
python = "^3.11"
psycopg = "^3.1"
pymongo = "^4.6"
[project]
dependencies = ["asyncpg>=0.29", "snowflake-connector-python"]`;
    expect(engines(detect('pyproject.toml', pyproject))).toEqual(['mongodb', 'postgresql', 'snowflake']);
  });
});

describe('connection strings, adapters and framework config', () => {
  it('reads URL schemes without leaking secrets', () => {
    const env = `APP_ENV=local
DATABASE_URL=postgres://admin:s3cret@db.example.com:5432/app
REDIS_URL=redis://localhost:6379
DB_CONNECTION=mysql`;
    const hints = detect('.env.example', env);
    expect(engines(hints)).toEqual(['mysql', 'postgresql', 'redis']);
    const pg = hints.find((h) => h.engine === 'postgresql')!;
    expect(pg).toEqual({ engine: 'postgresql', line: 1, detail: 'DATABASE_URL uses postgres://' });
    // No secret, host or full URL ends up in any detail.
    for (const h of hints) {
      expect(h.detail).not.toContain('s3cret');
      expect(h.detail).not.toContain('db.example.com');
      expect(h.detail).not.toContain('admin');
    }
  });

  it('application.properties (jdbc) without leaking the password', () => {
    const props = `spring.datasource.url=jdbc:postgresql://localhost:5432/app
spring.datasource.username=admin
spring.datasource.password=supersecret`;
    const hints = detect('src/main/resources/application.properties', props);
    expect(hints).toEqual([{ engine: 'postgresql', line: 0, detail: 'spring.datasource.url uses jdbc:postgresql:' }]);
    expect(hints.every((h) => !h.detail.includes('supersecret'))).toBe(true);
  });

  it('Rails database.yml adapter', () => {
    const yml = `default: &default
  adapter: postgresql
  host: localhost
  password: topsecret`;
    const hints = detect('config/database.yml', yml);
    expect(engines(hints)).toEqual(['postgresql']);
    expect(hints.some((h) => h.detail.includes('topsecret'))).toBe(false);
    expect(hints[0].detail).toBe('database.yml adapter "postgresql"');
  });

  it('Django settings ENGINE', () => {
    const settings = `DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': 'mydb',
    }
}`;
    const hints = detect('myproj/settings.py', settings);
    expect(engines(hints)).toEqual(['postgresql']);
    expect(hints[0].detail).toBe('Django ENGINE "django.db.backends.postgresql"');
  });

  it('never inspects a real .env even if asked directly', () => {
    expect(detect('.env', 'DATABASE_URL=postgres://u:p@h/db')).toEqual([]);
  });
});

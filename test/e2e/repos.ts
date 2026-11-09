/** Pinned public repositories for the real-repo regression suite. Bump a SHA to refresh a repo. */
export interface E2eRepo {
  /** Snapshot file name (without extension). */
  id: string;
  /** `owner/name` on GitHub. */
  repo: string;
  /** Full commit SHA. */
  sha: string;
  /** Ecosystem, informational. */
  note: string;
  /** Limit the checkout to these paths (huge monorepos). */
  sparse?: string[];
}

export const REPOS: readonly E2eRepo[] = [
  { id: 'realworld-node-prisma', repo: 'gothinkster/node-express-realworld-example-app', sha: '30b68e1e881462b2f4164ea09ab4c4f5699c7b0b', note: 'Prisma' },
  { id: 'realworld-rails', repo: 'gothinkster/rails-realworld-example-app', sha: 'a2ae4fff78b3337683cea988c023281dcb5551b9', note: 'Rails' },
  { id: 'realworld-django', repo: 'gothinkster/django-realworld-example-app', sha: '29c9d42831fa0cfc5a4aa7561f674396eacf20a2', note: 'Django' },
  { id: 'realworld-laravel', repo: 'gothinkster/laravel-realworld-example-app', sha: 'e45c37c8a5f57131c9d239f1fc104c227e66b6ee', note: 'Laravel' },
  { id: 'realworld-gin-gorm', repo: 'gothinkster/golang-gin-realworld-example-app', sha: 'a41289b2a4951e7cc09066f86742a27f85121c9b', note: 'GORM' },
  { id: 'realworld-aspnetcore', repo: 'gothinkster/aspnetcore-realworld-example-app', sha: '9345f18abf36b778abe2f290467ba432bf1f7e5c', note: 'EF Core' },
  { id: 'realworld-spring-boot', repo: 'gothinkster/spring-boot-realworld-example-app', sha: 'ee17e31aafe733d98c4853c8b9a74d7f2f6c924a', note: 'Spring Boot' },
  { id: 'realworld-flask', repo: 'gothinkster/flask-realworld-example-app', sha: '4b95fb2227dfeb5dd1a45d89b2bf48630b93fd28', note: 'Flask / SQLAlchemy' },
  { id: 'realworld-nestjs', repo: 'lujakob/nestjs-realworld-example-app', sha: 'c1c2cc4e448b279ff083272df1ac50d20c3304fa', note: 'TypeORM' },
  { id: 'mastodon', repo: 'mastodon/mastodon', sha: '4f38e6674e5190845fe195ce9f8eb07f2ae7109d', note: 'Rails schema.rb (large)' },
  { id: 'calcom', repo: 'calcom/cal.com', sha: '2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee', note: 'Prisma (large)', sparse: ['packages/prisma'] },
  { id: 'nextjs-saas-starter', repo: 'nextjs/saas-starter', sha: '6e33e58b1e553a41fe22e6b941a7229a002de361', note: 'Drizzle' },
  { id: 'kysely', repo: 'kysely-org/kysely', sha: '4fbf01841969c4e34de920f2e027d65ce8637ff5', note: 'Kysely' },
  { id: 'microblog', repo: 'miguelgrinberg/microblog', sha: 'a975ef64864354867c88e0ed3a17ba7d17dca752', note: 'SQLAlchemy + Alembic' },
  { id: 'hexpm', repo: 'hexpm/hexpm', sha: '7fcc788cde63fe0a1d3e3cd1ec58372d8c17bfbe', note: 'Ecto' },
  { id: 'symfony-demo', repo: 'symfony/demo', sha: 'f42980c690b4bf335fa41bbafdb075bb67b719c2', note: 'Doctrine' },
  { id: 'exposed', repo: 'JetBrains/Exposed', sha: '0957638c87e7a6ffae3835b0e11414ab2c8c65ac', note: 'Exposed' },
  { id: 'ent', repo: 'ent/ent', sha: '8037bc89bcab9a264099afa2672581237a3e079b', note: 'Ent' },
  { id: 'sea-orm', repo: 'SeaQL/sea-orm', sha: '7769dffb852145770c748d1adec9dd6d39d73110', note: 'SeaORM' },
  { id: 'devconnector', repo: 'bradtraversy/devconnector_2.0', sha: '0da5372c1f26d5e3f7d419844b4c23e9872909b1', note: 'Mongoose' },
];

import { describe, expect, it } from 'vitest';
import { resolveSchema } from '../../../src/core/resolve';
import { efcoreParser } from '../../../src/parsers/efcore';

// Regressions found while scanning gothinkster/aspnetcore-realworld-example-app.
describe('efcore parser regressions', () => {
  const context = {
    path: 'src/Infrastructure/AppContext.cs',
    text: [
      'using Microsoft.EntityFrameworkCore;',
      'namespace App.Infrastructure;',
      'public class AppContext(DbContextOptions options) : DbContext(options)',
      '{',
      '    public DbSet<Article> Articles { get; init; } = null!;',
      '    public DbSet<Person> Persons { get; init; } = null!;',
      '}',
    ].join('\n'),
  };
  const article = {
    path: 'src/Domain/Article.cs',
    text: 'namespace App.Domain;\npublic class Article\n{\n    public int ArticleId { get; init; }\n    public string? Title { get; set; }\n    public Person? Author { get; init; }\n}\n',
  };
  const person = {
    path: 'src/Domain/Person.cs',
    text: 'namespace App.Domain;\npublic class Person\n{\n    public int PersonId { get; init; }\n    public string? Username { get; set; }\n}\n',
  };
  const dto = {
    path: 'src/Features/ArticleEnvelope.cs',
    text: 'namespace App.Features;\npublic class ArticleEnvelope\n{\n    public Article Article { get; set; }\n}\n',
  };

  it('recognises DbContext subclasses that use C# 12 primary constructors', () => {
    const r = efcoreParser.parse(context);
    expect(r.entities.map((e) => [e.name, e.modelName])).toEqual([
      ['Articles', 'Article'],
      ['Persons', 'Person'],
    ]);
  });

  it('claims plain POCO entity files and keeps only classes confirmed by a DbSet', () => {
    for (const f of [article, person, dto]) expect(efcoreParser.detect(f), f.path).toBe(true);
    expect(efcoreParser.detect({ path: 'src/Util.cs', text: 'static class Util { static int X() => 1; }' })).toBe(false);
    const r = resolveSchema(
      [context, article, person, dto].map((f) => ({ file: f.path, kind: 'efcore' as const, result: efcoreParser.parse(f) })),
    );
    expect(r.entities.map((e) => e.id)).toEqual(['articles', 'persons']);
    expect(r.relations).toEqual([expect.objectContaining({ from: 'articles', fromColumns: ['AuthorId'], to: 'persons' })]);
  });
});

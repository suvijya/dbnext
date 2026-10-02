import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { efcoreParser } from '../../../src/parsers/efcore';

const parse = (path: string, text: string) => efcoreParser.parse({ path, text });
const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'efcore', result: parse(path, text) });
const cols = (e: { columns: { name: string }[] }) => e.columns.map((c) => c.name);

describe('efcoreParser.detect', () => {
  it('claims DbContext, migrations, snapshots, configs and annotated entities', () => {
    expect(efcoreParser.detect({ path: 'Ctx.cs', text: 'public class AppDbContext : DbContext { public DbSet<Blog> Blogs {get;set;} }' })).toBe(true);
    expect(efcoreParser.detect({ path: 'M.cs', text: 'public partial class Init : Migration { void Up(MigrationBuilder migrationBuilder){} }' })).toBe(true);
    expect(efcoreParser.detect({ path: 'C.cs', text: 'class BlogConfig : IEntityTypeConfiguration<Blog> {}' })).toBe(true);
    expect(efcoreParser.detect({ path: 'Blog.cs', text: 'using Microsoft.EntityFrameworkCore;\n[Table("blogs")] public class Blog { [Key] public int Id {get;set;} }' })).toBe(true);
  });
  it('does not claim unrelated C#', () => {
    expect(efcoreParser.detect({ path: 'Prog.cs', text: 'public class Program { static void Main() {} }' })).toBe(false);
  });
});

describe('efcoreParser – entity classes (a)', () => {
  it('reads POCO columns, data annotations, conventions and marks them candidate', () => {
    const text = `
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace App.Models;

[Table("blogs", Schema = "blogging")]
public class Blog
{
    public int BlogId { get; set; }

    [Required]
    [Column("blog_url", TypeName = "varchar(200)")]
    public string Url { get; set; } = null!;

    public string? Description { get; set; }

    public List<Post> Posts { get; } = new();
}`;
    const r = parse('Blog.cs', text);
    expect(r.entities).toHaveLength(1);
    const e = r.entities[0];
    expect(e).toMatchObject({ name: 'blogs', schema: 'blogging', modelName: 'Blog', nameCertainty: 2, candidate: true });
    expect(cols(e)).toEqual(['BlogId', 'blog_url', 'Description']); // collection nav excluded
    expect(e.columns[0]).toMatchObject({ name: 'BlogId', primaryKey: true, nullable: false }); // ${Class}Id convention
    expect(e.columns[1]).toMatchObject({ name: 'blog_url', type: 'varchar(200)', nullable: false });
    expect(e.columns[2]).toMatchObject({ name: 'Description', nullable: true }); // string? → nullable
    // collection navigation → one-to-many
    expect(r.relations).toEqual([expect.objectContaining({ from: { model: 'Blog' }, to: { model: 'Post' }, cardinality: 'one-to-many' })]);
  });

  it('maps a reference navigation + FK property to many-to-one', () => {
    const text = `
#nullable enable
namespace App.Models;
public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}`;
    const r = parse('Post.cs', text);
    const e = r.entities[0];
    expect(cols(e)).toEqual(['Id', 'Title', 'BlogId']);
    expect(e.columns.find((c) => c.name === 'Title')).toMatchObject({ nullable: false }); // NRT on
    expect(r.relations).toEqual([
      expect.objectContaining({ from: { model: 'Post' }, fromColumns: ['BlogId'], to: { model: 'Blog' }, cardinality: 'many-to-one', optional: false }),
    ]);
  });
});

describe('efcoreParser – DbContext fluent API (b) end to end', () => {
  it('confirms candidates via DbSet, applies ToTable/HasColumnName/IsRequired and HasOne/WithMany', () => {
    const blog = `
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations.Schema;
namespace App.Models;
[Table("blogs")]
public class Blog { public int BlogId { get; set; } public List<Post> Posts { get; } = new(); }`;
    const post = `
#nullable enable
namespace App.Models;
public class Post { public int Id { get; set; } public string Title { get; set; } = ""; public int BlogId { get; set; } public Blog Blog { get; set; } = null!; }`;
    const ctx = `
using Microsoft.EntityFrameworkCore;
namespace App.Data;
public class AppDbContext : DbContext
{
    public DbSet<Blog> Blogs { get; set; }
    public DbSet<Post> Posts { get; set; }

    protected override void OnConfiguring(DbContextOptionsBuilder options) => options.UseSqlServer("conn");

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Post>(e =>
        {
            e.Property(p => p.Title).HasColumnName("title").IsRequired().HasMaxLength(200);
            e.HasOne(p => p.Blog).WithMany(b => b.Posts).HasForeignKey(p => p.BlogId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}`;
    const r = resolveSchema([fr('Models/Blog.cs', blog), fr('Models/Post.cs', post), fr('Data/AppDbContext.cs', ctx)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['blogs', 'posts']);
    const posts = r.entities.find((e) => e.id === 'posts')!;
    expect(cols(posts)).toEqual(['Id', 'title', 'BlogId']); // Title renamed to title via fluent HasColumnName
    expect(posts.columns.find((c) => c.name === 'title')).toMatchObject({ nullable: false }); // IsRequired
    expect(r.relations).toHaveLength(1);
    expect(r.relations[0]).toMatchObject({ from: 'posts', fromColumns: ['BlogId'], to: 'blogs', cardinality: 'many-to-one', onDelete: 'CASCADE', optional: false });
  });

  it('reads an engine hint from UseSqlServer', () => {
    const ctx = `
using Microsoft.EntityFrameworkCore;
public class Ctx : DbContext {
    public DbSet<Thing> Things { get; set; }
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseNpgsql("conn");
}`;
    const r = parse('Ctx.cs', ctx);
    expect(r.engines).toEqual([expect.objectContaining({ engine: 'postgresql' })]);
  });

  it('reads an IEntityTypeConfiguration<T> class', () => {
    const cfg = `
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
public class BlogConfiguration : IEntityTypeConfiguration<Blog>
{
    public void Configure(EntityTypeBuilder<Blog> builder)
    {
        builder.ToTable("blogs", "dbo");
        builder.HasIndex(b => b.Url).IsUnique();
    }
}`;
    const r = parse('BlogConfiguration.cs', cfg);
    const e = r.entities.find((x) => x.modelName === 'Blog')!;
    expect(e).toMatchObject({ name: 'blogs', schema: 'dbo', nameCertainty: 2 });
    expect(e.indexes).toEqual([expect.objectContaining({ columns: ['Url'], unique: true })]);
  });
});

describe('efcoreParser – migrations (c) end to end', () => {
  it('reads CreateTable columns, primary keys and foreign keys from the Up method', () => {
    const text = `
using Microsoft.EntityFrameworkCore.Migrations;
public partial class Init : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "Blogs",
            columns: table => new
            {
                BlogId = table.Column<int>(type: "int", nullable: false)
                    .Annotation("SqlServer:Identity", "1, 1"),
                Url = table.Column<string>(name: "url", type: "nvarchar(max)", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_Blogs", x => x.BlogId);
            });

        migrationBuilder.CreateTable(
            name: "Posts",
            columns: table => new
            {
                Id = table.Column<int>(type: "int", nullable: false),
                BlogId = table.Column<int>(type: "int", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_Posts", x => x.Id);
                table.ForeignKey(
                    name: "FK_Posts_Blogs_BlogId",
                    column: x => x.BlogId,
                    principalTable: "Blogs",
                    principalColumn: "BlogId",
                    onDelete: ReferentialAction.Cascade);
            });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "Posts");
    }
}`;
    const result = parse('Migrations/20240101_Init.cs', text);
    expect(result.origin).toBe('migration');
    const r = resolveSchema([{ file: 'Migrations/20240101_Init.cs', kind: 'efcore', result }]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['blogs', 'posts']);
    const blogs = r.entities.find((e) => e.id === 'blogs')!;
    expect(cols(blogs)).toEqual(['BlogId', 'url']);
    expect(blogs.columns.find((c) => c.name === 'BlogId')).toMatchObject({ primaryKey: true, generated: true, nullable: false });
    expect(blogs.columns.find((c) => c.name === 'url')).toMatchObject({ nullable: true });
    expect(r.relations).toEqual([
      expect.objectContaining({ from: 'posts', fromColumns: ['BlogId'], to: 'blogs', kind: 'foreign-key', onDelete: 'CASCADE' }),
    ]);
    // the Down() drop must be ignored
    expect(r.entities.find((e) => e.id === 'posts')).toBeTruthy();
  });

  it('reads AddColumn / RenameColumn / DropColumn operations', () => {
    const f1 = 'Migrations/001_Init.cs';
    const f2 = 'Migrations/002_Change.cs';
    const init = `
using Microsoft.EntityFrameworkCore.Migrations;
public partial class Init : Migration {
  protected override void Up(MigrationBuilder migrationBuilder) {
    migrationBuilder.CreateTable(name: "Users",
      columns: table => new { Id = table.Column<int>(nullable: false), Name = table.Column<string>(nullable: true) },
      constraints: table => { table.PrimaryKey("PK_Users", x => x.Id); });
  }
}`;
    const change = `
using Microsoft.EntityFrameworkCore.Migrations;
public partial class Change : Migration {
  protected override void Up(MigrationBuilder migrationBuilder) {
    migrationBuilder.AddColumn<string>(name: "Email", table: "Users", nullable: false);
    migrationBuilder.RenameColumn(name: "Name", table: "Users", newName: "full_name");
  }
}`;
    const r = resolveSchema([fr(f2, change), fr(f1, init)]);
    const users = r.entities.find((e) => e.id === 'users')!;
    expect(cols(users)).toEqual(['Id', 'full_name', 'Email']);
  });
});

describe('efcoreParser – ModelSnapshot (d)', () => {
  it('reads string-based entities, properties, keys and relationships', () => {
    const text = `
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
[DbContext(typeof(AppDbContext))]
partial class AppDbContextModelSnapshot : ModelSnapshot
{
    protected override void BuildModel(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity("App.Models.Blog", b =>
        {
            b.Property<int>("BlogId").ValueGeneratedOnAdd().HasColumnType("int");
            b.Property<string>("Url").IsRequired().HasColumnName("url").HasColumnType("nvarchar(max)");
            b.HasKey("BlogId");
            b.ToTable("Blogs");
        });

        modelBuilder.Entity("App.Models.Post", b =>
        {
            b.Property<int>("Id").ValueGeneratedOnAdd();
            b.Property<int>("BlogId");
            b.HasKey("Id");
            b.ToTable("Posts");
            b.HasOne("App.Models.Blog", "Blog").WithMany("Posts").HasForeignKey("BlogId").OnDelete(DeleteBehavior.Cascade).IsRequired();
        });
    }
}`;
    const result = parse('AppDbContextModelSnapshot.cs', text);
    expect(result.origin).toBe('definition');
    const r = resolveSchema([{ file: 'AppDbContextModelSnapshot.cs', kind: 'efcore', result }]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['blogs', 'posts']);
    const blogs = r.entities.find((e) => e.id === 'blogs')!;
    expect(cols(blogs)).toEqual(['BlogId', 'url']);
    expect(blogs.columns.find((c) => c.name === 'BlogId')).toMatchObject({ primaryKey: true, generated: true, nullable: false });
    expect(blogs.columns.find((c) => c.name === 'url')).toMatchObject({ type: 'nvarchar(max)', nullable: false });
    expect(r.relations).toEqual([
      expect.objectContaining({ from: 'posts', fromColumns: ['BlogId'], to: 'blogs', cardinality: 'many-to-one', onDelete: 'CASCADE' }),
    ]);
  });

  it('ignores *.Designer.cs files', () => {
    const r = parse('Migrations/001_Init.Designer.cs', 'partial class Init { }');
    expect(r.entities).toHaveLength(0);
  });
});

describe('efcoreParser – robustness', () => {
  it('never throws on malformed input', () => {
    for (const text of [
      '[Table("x") public class Broken {',
      'public class C : DbContext { public DbSet<',
      'migrationBuilder.CreateTable(name: "X", columns: table => new {',
      'modelBuilder.Entity<>(e => {',
      '',
    ]) {
      expect(() => parse('X.cs', text)).not.toThrow();
    }
  });
});

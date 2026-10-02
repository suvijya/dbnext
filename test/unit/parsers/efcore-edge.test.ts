import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { efcoreParser } from '../../../src/parsers/efcore';

const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'efcore', result: efcoreParser.parse({ path, text }) });

describe('efcore edge cases', () => {
  it('handles file-scoped namespaces and required members', () => {
    const text = [
      'namespace Shop.Models;',
      'public class Product {',
      '  public int Id { get; set; }',
      '  public required string Name { get; set; }',
      '  public decimal Price { get; set; }',
      '  public int? CategoryId { get; set; }',
      '}',
    ].join('\n');
    const product = efcoreParser.parse({ path: 'Product.cs', text }).entities.find((e) => e.modelName === 'Product')!;
    expect(product.columns.map((c) => c.name)).toEqual(['Id', 'Name', 'Price', 'CategoryId']);
    expect(product.columns.find((c) => c.name === 'Id')!.primaryKey).toBe(true);
    expect(product.columns.find((c) => c.name === 'CategoryId')!.nullable).toBe(true);
  });

  it('reads record primary-constructor entities with NRT nullability', () => {
    const text = 'namespace M;\npublic record Customer(int Id, string Name, string? Email);';
    const customer = efcoreParser.parse({ path: 'Customer.cs', text }).entities.find((e) => e.modelName === 'Customer')!;
    expect(customer.columns.find((c) => c.name === 'Name')!.nullable).toBe(false);
    expect(customer.columns.find((c) => c.name === 'Email')!.nullable).toBe(true);
  });

  it('does not duplicate a table shared by two DbContexts', () => {
    const ctx = (name: string) =>
      `using Microsoft.EntityFrameworkCore;\npublic class User { public int Id {get;set;} public string Name {get;set;} }\n` +
      `public class ${name} : DbContext { public DbSet<User> Users {get;set;}\n` +
      `  protected override void OnModelCreating(ModelBuilder b){ b.Entity<User>().ToTable("users"); } }`;
    const r = resolveSchema([fr('CtxA.cs', ctx('CtxA')), fr('CtxB.cs', ctx('CtxB'))]);
    expect(r.entities.filter((e) => e.id === 'users')).toHaveLength(1);
  });

  // NOT FIXED — root cause is cross-area (resolver). Documented for the resolver owner.
  // EF Core owned types (value objects) configured with `OwnsOne` / `OwnsMany` (no `[Owned]`
  // attribute) have their columns inlined into the owner's table and never get their own table.
  // DBNext currently emits the owned POCO as a phantom table and a phantom `<Nav>Id` FK relation,
  // because: (a) the POCO is parsed as a candidate entity, (b) the owner's navigation property keeps
  // it alive, and (c) the `OwnsOne` call lives in a THIRD file (the DbContext / configuration), so no
  // single parser pass can suppress it. Reproduced on dotnet-architecture/eShopOnWeb: `Address` and
  // `CatalogItemOrdered` appear as tables with `orders(ShipToAddressId) -> address` /
  // `orderitems(ItemOrderedId) -> catalogitemordered` phantom relations.
  // Proposed fix (resolver): let the EF Core parser mark a navigation / entity as "owned" (new flag
  // on RawRelation or RawEntity) when it sees `OwnsOne`/`OwnsMany`, and have resolveSchema drop owned
  // candidate entities and their inbound navigation relations.
  it('does not emit owned types (OwnsOne/OwnsMany) as phantom tables + FK relations', async () => {
    const { resolveSchema } = await import('../../../src/core/resolve');
    const files = [
      {
        path: 'Data/ShopContext.cs',
        text: 'using Microsoft.EntityFrameworkCore;\npublic class ShopContext : DbContext\n{\n    public DbSet<Order> Orders { get; set; }\n    public DbSet<Item> Items { get; set; }\n    protected override void OnModelCreating(ModelBuilder b)\n    {\n        b.Entity<Order>(o =>\n        {\n            o.OwnsOne(x => x.ShipToAddress, a => { a.Property(p => p.City).HasMaxLength(100); });\n            o.OwnsMany(x => x.Lines);\n        });\n    }\n}\n',
      },
      {
        path: 'Domain/Order.cs',
        text: 'public class Order\n{\n    public int Id { get; set; }\n    public Address ShipToAddress { get; set; }\n    public List<OrderLine> Lines { get; set; }\n    public Item Featured { get; set; }\n}\npublic class Address\n{\n    public string City { get; set; }\n}\npublic class OrderLine\n{\n    public int Qty { get; set; }\n}\npublic class Item\n{\n    public int Id { get; set; }\n}\n',
      },
    ];
    const r = resolveSchema(files.map((f) => ({ file: f.path, kind: 'efcore' as const, result: efcoreParser.parse(f) })));
    expect(r.entities.map((e) => e.id).sort()).toEqual(['items', 'orders']);
    const orders = r.entities.find((e) => e.id === 'orders')!;
    expect(orders.columns.map((c) => c.name)).not.toContain('ShipToAddressId');
    expect(r.relations.map((x) => `${x.from}.${x.fromColumns}>${x.to}`)).toEqual(['orders.FeaturedId>items']);
  });
});

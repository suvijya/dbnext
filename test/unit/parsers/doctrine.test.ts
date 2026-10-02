import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { doctrineParser } from '../../../src/parsers/doctrine';

const parse = (path: string, text: string) => doctrineParser.parse({ path, text });
const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'doctrine', result: parse(path, text) });
const colNames = (cols: { name: string }[]) => cols.map((c) => c.name);

describe('doctrine detect', () => {
  it('claims attribute and annotation entities', () => {
    expect(doctrineParser.detect({ path: 'src/Entity/User.php', text: 'use Doctrine\\ORM\\Mapping as ORM;\n#[ORM\\Entity]\nclass User {}' })).toBe(true);
    expect(doctrineParser.detect({ path: 'src/Entity/Product.php', text: '/** @ORM\\Entity */\nclass Product {}' })).toBe(true);
  });

  it('does not claim Laravel models or plain PHP', () => {
    expect(doctrineParser.detect({ path: 'app/Models/User.php', text: 'class User extends Model {}' })).toBe(false);
    expect(doctrineParser.detect({ path: 'src/Helper.php', text: '<?php class Helper {}' })).toBe(false);
  });
});

describe('doctrine attributes', () => {
  const text = `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;
use Doctrine\\Common\\Collections\\Collection;

#[ORM\\Entity]
#[ORM\\Table(name: 'users', schema: 'auth')]
#[ORM\\Index(columns: ['email'], name: 'idx_email')]
class User
{
    #[ORM\\Id]
    #[ORM\\GeneratedValue]
    #[ORM\\Column(type: 'integer')]
    private int $id;

    #[ORM\\Column(type: 'string', length: 180, unique: true)]
    private string $email;

    #[ORM\\Column(name: 'full_name', type: 'string', nullable: true)]
    private ?string $fullName = null;

    #[ORM\\ManyToOne(targetEntity: Org::class, inversedBy: 'users')]
    #[ORM\\JoinColumn(name: 'org_id', referencedColumnName: 'id', nullable: false, onDelete: 'CASCADE')]
    private Org $org;

    #[ORM\\ManyToMany(targetEntity: Role::class)]
    #[ORM\\JoinTable(name: 'user_roles')]
    private Collection $roles;
}
`;
  const result = parse('src/Entity/User.php', text);
  const user = result.entities[0];

  it('reads the table, schema, model and an index', () => {
    expect(user).toMatchObject({ name: 'users', schema: 'auth', modelName: 'User', nameCertainty: 2 });
    expect(user.indexes).toEqual([expect.objectContaining({ columns: ['email'], name: 'idx_email', unique: false })]);
  });

  it('builds columns with NOT NULL by default, honours name/nullable/unique and the FK column', () => {
    expect(colNames(user.columns)).toEqual(['id', 'email', 'full_name', 'org_id']);
    expect(user.columns.find((c) => c.name === 'id')).toMatchObject({ type: 'integer', primaryKey: true, generated: true, nullable: false });
    expect(user.columns.find((c) => c.name === 'email')).toMatchObject({ type: 'string', unique: true, nullable: false });
    expect(user.columns.find((c) => c.name === 'full_name')).toMatchObject({ nullable: true });
  });

  it('emits ManyToOne (with JoinColumn) and ManyToMany (with JoinTable)', () => {
    const mto = result.relations.find((r) => r.cardinality === 'many-to-one')!;
    expect(mto).toMatchObject({ fromColumns: ['org_id'], toColumns: ['id'], onDelete: 'CASCADE', optional: false });
    expect(mto.to).toEqual({ model: 'Org' });
    const m2m = result.relations.find((r) => r.cardinality === 'many-to-many')!;
    expect(m2m.to).toEqual({ model: 'Role' });
    expect(m2m.through).toEqual({ name: 'user_roles' });
  });
});

describe('doctrine annotations', () => {
  const text = `<?php

namespace App\\Entity;

use Doctrine\\ORM\\Mapping as ORM;

/**
 * @ORM\\Entity
 * @ORM\\Table(name="products")
 */
class Product
{
    /**
     * @ORM\\Id
     * @ORM\\GeneratedValue
     * @ORM\\Column(type="integer")
     */
    private $id;

    /** @ORM\\Column(type="string", length=255) */
    private $name;

    /**
     * @ORM\\ManyToOne(targetEntity="Category")
     * @ORM\\JoinColumn(name="category_id", referencedColumnName="id")
     */
    private $category;
}
`;
  const result = parse('src/Entity/Product.php', text);
  const product = result.entities[0];

  it('reads docblock mapping the same way as attributes', () => {
    expect(product).toMatchObject({ name: 'products', modelName: 'Product', nameCertainty: 2 });
    expect(colNames(product.columns)).toEqual(['id', 'name', 'category_id']);
    expect(product.columns.find((c) => c.name === 'id')).toMatchObject({ type: 'integer', primaryKey: true, generated: true });
    expect(product.columns.find((c) => c.name === 'name')!.type).toBe('string');
  });

  it('emits the ManyToOne relation (JoinColumn nullable defaults to true)', () => {
    const rel = result.relations[0];
    expect(rel).toMatchObject({ fromColumns: ['category_id'], toColumns: ['id'], cardinality: 'many-to-one', optional: true });
    expect(rel.to).toEqual({ model: 'Category' });
  });

  it('does not throw on malformed input', () => {
    expect(() => parse('x.php', '<?php use Doctrine\\ORM\\Mapping as ORM;\n#[ORM\\Entity]\nclass A { #[ORM\\Column(type: ')).not.toThrow();
  });
});

describe('doctrine mapped superclass inheritance', () => {
  const text = `<?php
use Doctrine\\ORM\\Mapping as ORM;

#[ORM\\MappedSuperclass]
abstract class Base
{
    #[ORM\\Id]
    #[ORM\\GeneratedValue]
    #[ORM\\Column(type: 'integer')]
    protected int $id;

    #[ORM\\Column(type: 'datetime')]
    protected \\DateTime $createdAt;
}

#[ORM\\Entity]
#[ORM\\Table(name: 'articles')]
class Article extends Base
{
    #[ORM\\Column(type: 'string')]
    private string $title;
}
`;

  it('marks the superclass abstract and copies its columns into the entity', () => {
    const r = resolveSchema([fr('src/Entity/Article.php', text)]);
    expect(r.entities.map((e) => e.id)).toEqual(['articles']);
    const article = r.entities[0];
    expect(colNames(article.columns)).toEqual(['id', 'created_at', 'title']);
  });
});

describe('doctrine end-to-end', () => {
  const user = `<?php
use Doctrine\\ORM\\Mapping as ORM;
#[ORM\\Entity]
#[ORM\\Table(name: 'users')]
class User {
    #[ORM\\Id] #[ORM\\Column(type: 'integer')]
    private int $id;
    #[ORM\\ManyToOne(targetEntity: Org::class)]
    #[ORM\\JoinColumn(name: 'org_id', nullable: false)]
    private Org $org;
    #[ORM\\ManyToMany(targetEntity: Role::class)]
    #[ORM\\JoinTable(name: 'user_roles')]
    private Collection $roles;
}`;
  const org = `<?php
use Doctrine\\ORM\\Mapping as ORM;
#[ORM\\Entity] #[ORM\\Table(name: 'orgs')]
class Org {
    #[ORM\\Id] #[ORM\\Column(type: 'integer')]
    private int $id;
}`;
  const role = `<?php
use Doctrine\\ORM\\Mapping as ORM;
#[ORM\\Entity] #[ORM\\Table(name: 'roles')]
class Role {
    #[ORM\\Id] #[ORM\\Column(type: 'integer')]
    private int $id;
}`;

  const r = resolveSchema([fr('src/Entity/User.php', user), fr('src/Entity/Org.php', org), fr('src/Entity/Role.php', role)]);

  it('builds entities and links users → orgs with the FK column', () => {
    expect(r.entities.map((e) => e.id)).toEqual(['orgs', 'roles', 'users']);
    const users = r.entities.find((e) => e.id === 'users')!;
    expect(users.columns.find((c) => c.name === 'org_id')!.references).toMatchObject({ entity: 'orgs' });
    const rel = r.relations.find((x) => x.from === 'users' && x.to === 'orgs')!;
    expect(rel).toMatchObject({ cardinality: 'many-to-one', fromColumns: ['org_id'], optional: false });
  });

  it('builds the many-to-many between users and roles', () => {
    const m2m = r.relations.find((x) => x.cardinality === 'many-to-many')!;
    expect([m2m.from, m2m.to].sort()).toEqual(['roles', 'users']);
    expect(m2m.throughName).toBe('user_roles');
  });
});

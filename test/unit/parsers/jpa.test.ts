import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { jpaParser } from '../../../src/parsers/jpa';

const parse = (path: string, text: string) => jpaParser.parse({ path, text });
const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'jpa', result: parse(path, text) });
const cols = (e: { columns: { name: string }[] }) => e.columns.map((c) => c.name);

describe('jpaParser.detect', () => {
  it('claims JPA / Hibernate and Spring Data files', () => {
    expect(jpaParser.detect({ path: 'User.java', text: 'import jakarta.persistence.*;\n@Entity class User {}' })).toBe(true);
    expect(jpaParser.detect({ path: 'Base.java', text: '@MappedSuperclass class Base {}' })).toBe(true);
    expect(jpaParser.detect({ path: 'Addr.java', text: '@Embeddable class Addr {}' })).toBe(true);
    expect(
      jpaParser.detect({ path: 'User.java', text: 'import org.springframework.data.relational.core.mapping.Table;\n@Table("users") class User {}' }),
    ).toBe(true);
  });

  it('does not claim Exposed, plain code or unrelated annotations', () => {
    expect(jpaParser.detect({ path: 'Users.kt', text: 'import org.jetbrains.exposed.sql.Table\nobject Users : Table("users")' })).toBe(false);
    expect(jpaParser.detect({ path: 'Main.java', text: 'public class Main { public static void main(String[] a) {} }' })).toBe(false);
    expect(jpaParser.detect({ path: 'C.java', text: '@RestController class C {}' })).toBe(false);
  });
});

describe('jpaParser – Java', () => {
  it('reads tables, columns, naming, nullability and generated keys', () => {
    const text = `
import jakarta.persistence.*;

@Entity
@Table(name = "app_users", schema = "auth")
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "email_address", nullable = false, unique = true, length = 255)
    private String email;

    private int loginCount;

    @Column(nullable = false)
    private String displayName;

    private String bio;

    @Transient
    private String cache;

    static final String TABLE = "x";
}`;
    const r = parse('User.java', text);
    expect(r.entities).toHaveLength(1);
    const e = r.entities[0];
    expect(e).toMatchObject({ name: 'app_users', schema: 'auth', modelName: 'User', nameCertainty: 2 });
    expect(cols(e)).toEqual(['id', 'email_address', 'login_count', 'display_name', 'bio']);
    expect(e.columns[0]).toMatchObject({ name: 'id', primaryKey: true, nullable: false, generated: true });
    expect(e.columns[1]).toMatchObject({ name: 'email_address', nullable: false, unique: true });
    expect(e.columns[2]).toMatchObject({ name: 'login_count', type: 'int', nullable: false }); // primitive → NOT NULL
    expect(e.columns[3]).toMatchObject({ nullable: false });
    expect(e.columns[4]).toMatchObject({ name: 'bio', nullable: true }); // wrapper object → nullable
  });

  it('derives the table name from @Entity(name) with certainty 1', () => {
    const r = parse('Account.java', '@Entity(name = "Account") class AccountEntity { @Id Long id; }');
    expect(r.entities[0]).toMatchObject({ name: 'account', modelName: 'AccountEntity', nameCertainty: 1 });
  });

  it('maps @ManyToOne + @JoinColumn to a foreign key and adds the FK column', () => {
    const text = `
import jakarta.persistence.*;
@Entity
public class Post {
    @Id Long id;
    @ManyToOne(optional = false)
    @JoinColumn(name = "author_id")
    private User author;

    @ManyToOne
    private User editor;
}`;
    const r = parse('Post.java', text);
    const e = r.entities[0];
    expect(cols(e)).toEqual(['id', 'author_id', 'editor_id']); // default join column = snake(property)_id
    expect(e.columns.find((c) => c.name === 'author_id')).toMatchObject({ nullable: false });
    expect(e.columns.find((c) => c.name === 'editor_id')).toMatchObject({ nullable: true });
    expect(r.relations).toHaveLength(2);
    expect(r.relations[0]).toMatchObject({
      from: { model: 'Post' },
      fromColumns: ['author_id'],
      to: { model: 'User' },
      cardinality: 'many-to-one',
      kind: 'orm',
      optional: false,
    });
  });

  it('parses @Table indexes and unique constraints and enum columns', () => {
    const text = `
import jakarta.persistence.*;
@Entity
@Table(name = "orders", indexes = { @Index(name = "ix_code", columnList = "code", unique = true), @Index(columnList = "status, created_at") },
       uniqueConstraints = @UniqueConstraint(columnNames = {"customer_id", "code"}))
public class Order {
    @Id Long id;
    @Column(name = "code") String code;
    @Enumerated(EnumType.STRING)
    private Status status;
}

enum Status { NEW, PAID, SHIPPED }`;
    const r = parse('Order.java', text);
    const e = r.entities[0];
    expect(e.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ix_code', columns: ['code'], unique: true }),
        expect.objectContaining({ columns: ['status', 'created_at'], unique: false }),
        expect.objectContaining({ columns: ['customer_id', 'code'], unique: true }),
      ]),
    );
    expect(r.enums).toEqual([expect.objectContaining({ name: 'Status', values: ['NEW', 'PAID', 'SHIPPED'] })]);
    expect(e.columns.find((c) => c.name === 'status')).toMatchObject({ enumRef: 'Status' });
  });
});

describe('jpaParser – Kotlin', () => {
  it('reads primary-constructor properties with Kotlin nullability', () => {
    const text = `
import jakarta.persistence.*

@Entity
@Table(name = "members")
class Member(
    @Id @GeneratedValue val id: Long? = null,
    @Column(name = "full_name", nullable = false) val fullName: String,
    val nickname: String?,
    val age: Int,
)`;
    const r = parse('Member.kt', text);
    const e = r.entities[0];
    expect(e).toMatchObject({ name: 'members', modelName: 'Member' });
    expect(cols(e)).toEqual(['id', 'full_name', 'nickname', 'age']);
    expect(e.columns.find((c) => c.name === 'full_name')).toMatchObject({ nullable: false });
    expect(e.columns.find((c) => c.name === 'nickname')).toMatchObject({ nullable: true }); // `?`
    expect(e.columns.find((c) => c.name === 'age')).toMatchObject({ type: 'Int', nullable: false });
    expect(e.columns.find((c) => c.name === 'id')).toMatchObject({ primaryKey: true, nullable: false }); // @Id → NOT NULL
  });

  it('maps @ManyToMany + @JoinTable (owning side only)', () => {
    const text = `
import jakarta.persistence.*
@Entity
class Post(
    @Id val id: Long = 0,
    @ManyToMany
    @JoinTable(name = "post_tags")
    val tags: MutableList<Tag> = mutableListOf(),
)`;
    const r = parse('Post.kt', text);
    expect(r.relations).toEqual([
      expect.objectContaining({
        from: { model: 'Post' },
        to: { model: 'Tag' },
        cardinality: 'many-to-many',
        through: { name: 'post_tags' },
        kind: 'orm',
      }),
    ]);
  });
});

describe('jpaParser – inheritance (end to end)', () => {
  it('copies @MappedSuperclass columns into children', () => {
    const base = `
import jakarta.persistence.*;
@MappedSuperclass
public abstract class Auditable {
    @Column(name = "created_at", nullable = false) private java.time.Instant createdAt;
    @Column(name = "updated_at") private java.time.Instant updatedAt;
}`;
    const child = `
import jakarta.persistence.*;
@Entity
@Table(name = "products")
public class Product extends Auditable {
    @Id Long id;
    @Column(nullable = false) String name;
}`;
    const r = resolveSchema([fr('Auditable.java', base), fr('Product.java', child)]);
    const product = r.entities.find((e) => e.id === 'products')!;
    expect(cols(product)).toEqual(expect.arrayContaining(['id', 'name', 'created_at', 'updated_at']));
    // The mapped superclass is not a table of its own.
    expect(r.entities.map((e) => e.id)).toEqual(['products']);
  });

  it('merges single-table-inheritance children into the base table', () => {
    const base = `
import jakarta.persistence.*;
@Entity
@Table(name = "payments")
@Inheritance(strategy = InheritanceType.SINGLE_TABLE)
public class Payment {
    @Id Long id;
    @Column(nullable = false) java.math.BigDecimal amount;
}`;
    const child = `
import jakarta.persistence.*;
@Entity
@DiscriminatorValue("CARD")
public class CardPayment extends Payment {
    @Column(name = "card_last4") String cardLast4;
}`;
    const r = resolveSchema([fr('Payment.java', base), fr('CardPayment.java', child)]);
    expect(r.entities.map((e) => e.id)).toEqual(['payments']);
    expect(cols(r.entities[0])).toEqual(expect.arrayContaining(['id', 'amount', 'card_last4']));
  });
});

describe('jpaParser – end to end relations', () => {
  it('links a bidirectional @OneToMany / @ManyToOne pair', () => {
    const user = `
import jakarta.persistence.*;
@Entity @Table(name = "users")
public class User {
    @Id Long id;
    @OneToMany(mappedBy = "author")
    private java.util.List<Post> posts;
}`;
    const post = `
import jakarta.persistence.*;
@Entity @Table(name = "posts")
public class Post {
    @Id Long id;
    @ManyToOne(optional = false)
    @JoinColumn(name = "author_id")
    private User author;
}`;
    const r = resolveSchema([fr('User.java', user), fr('Post.java', post)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['posts', 'users']);
    expect(r.relations).toHaveLength(1);
    expect(r.relations[0]).toMatchObject({
      from: 'posts',
      fromColumns: ['author_id'],
      to: 'users',
      toColumns: ['id'],
      cardinality: 'many-to-one',
      optional: false,
    });
  });
});

describe('jpaParser – robustness', () => {
  it('never throws on malformed / truncated input', () => {
    for (const text of [
      '@Entity public class Broken { @Column(name = "x"',
      '@Entity class { }',
      'class User { @ManyToOne private',
      '@Entity\n@Table(\nclass User {',
      '',
      '// just a comment\n/* @Entity */ class NotAnEntity {}',
    ]) {
      expect(() => parse('X.java', text)).not.toThrow();
    }
    // commented-out entity must be ignored
    const r = parse('X.java', '// @Entity class Ghost { @Id Long id; }\nclass Plain {}');
    expect(r.entities).toHaveLength(0);
  });
});

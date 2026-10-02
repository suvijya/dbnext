import { describe, expect, it } from 'vitest';
import { jpaParser } from '../../../src/parsers/jpa';

const parse = (path: string, text: string) => jpaParser.parse({ path, text });

describe('jpa edge cases', () => {
  // Property access: JPA mapping annotations on getters instead of fields (access type PROPERTY).
  it('reads mapping annotations placed on getters (property access)', () => {
    const text = [
      'import jakarta.persistence.*;',
      '@Entity @Table(name="users")',
      'public class User {',
      '  private Long id;',
      '  private String email;',
      '  @Id @GeneratedValue public Long getId() { return id; }',
      '  @Column(name="email_address", nullable=false) public String getEmail() { return email; }',
      '}',
    ].join('\n');
    const user = parse('User.java', text).entities.find((e) => e.modelName === 'User')!;
    const id = user.columns.find((c) => c.name === 'id')!;
    expect(id).toMatchObject({ primaryKey: true, generated: true });
    const email = user.columns.find((c) => c.name === 'email_address')!;
    expect(email).toMatchObject({ nullable: false });
    // No duplicate column from the backing field.
    expect(user.columns.filter((c) => c.name === 'email_address' || c.name === 'email')).toHaveLength(1);
  });

  it('strips SQL quoting from @Table(name = "\\"Users\\"")', () => {
    const text = ['import jakarta.persistence.*;', '@Entity @Table(name = "\\"Users\\"")', 'public class U { @Id Long id; String name; }'].join('\n');
    const u = parse('U.java', text).entities.find((e) => e.modelName === 'U')!;
    expect(u.name).toBe('Users');
  });

  it('reads every column of a composite @JoinColumns', () => {
    const text = [
      'import jakarta.persistence.*;',
      '@Entity public class OrderLine {',
      '  @Id Long id;',
      '  @ManyToOne',
      '  @JoinColumns({ @JoinColumn(name="order_id"), @JoinColumn(name="order_tenant") })',
      '  private Order order;',
      '}',
    ].join('\n');
    const r = parse('OrderLine.java', text);
    const line = r.entities.find((e) => e.modelName === 'OrderLine')!;
    expect(line.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['order_id', 'order_tenant']));
    const rel = r.relations.find((x) => x.to.model === 'Order')!;
    expect(rel.fromColumns).toEqual(['order_id', 'order_tenant']);
  });

  it('does not merge a JOINED-inheritance subclass into its parent table', () => {
    const text = [
      'import jakarta.persistence.*;',
      '@Entity @Inheritance(strategy = InheritanceType.JOINED)',
      'public class Vehicle { @Id Long id; String name; }',
      '@Entity public class Car extends Vehicle { String doors; }',
    ].join('\n');
    const car = parse('Vehicle.java', text).entities.find((e) => e.modelName === 'Car')!;
    expect(car.sharedTable).toBeFalsy();
    expect(car.extends).toEqual(['Vehicle']);
  });

  it('expands @Embeddable Java records into their component columns', () => {
    const text = [
      'import jakarta.persistence.*;',
      '@Embeddable public record Address(String street, String city) {}',
      '@Entity public class Person { @Id Long id; @Embedded Address address; }',
    ].join('\n');
    const person = parse('Person.java', text).entities.find((e) => e.modelName === 'Person')!;
    expect(person.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'street', 'city']));
  });

  it('CRLF line endings produce identical results', () => {
    const text = [
      'import jakarta.persistence.*;',
      '@Entity @Table(name = "owners")',
      'public class Owner {',
      '  @Id @GeneratedValue Long id;',
      '  @Column(nullable = false) String firstName;',
      '  @OneToMany @JoinColumn(name = "owner_id") List<Pet> pets;',
      '}',
    ].join('\n');
    const lf = parse('Owner.java', text);
    const crlf = parse('Owner.java', text.replace(/\n/g, '\r\n'));
    expect(JSON.stringify(crlf)).toEqual(JSON.stringify(lf));
  });
});

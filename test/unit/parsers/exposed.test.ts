import { describe, expect, it } from 'vitest';
import type { FileResult } from '../../../src/core/model';
import { resolveSchema } from '../../../src/core/resolve';
import { exposedParser } from '../../../src/parsers/exposed';

const parse = (path: string, text: string) => exposedParser.parse({ path, text });
const fr = (path: string, text: string): FileResult => ({ file: path, kind: 'exposed', result: parse(path, text) });
const cols = (e: { columns: { name: string }[] }) => e.columns.map((c) => c.name);

describe('exposedParser.detect', () => {
  it('claims Exposed table objects', () => {
    expect(exposedParser.detect({ path: 'Users.kt', text: 'import org.jetbrains.exposed.dao.id.IntIdTable\nobject Users : IntIdTable("users")' })).toBe(true);
    expect(exposedParser.detect({ path: 'T.kt', text: 'object Cities : Table("cities") { }' })).toBe(true);
  });
  it('does not claim JPA / unrelated Kotlin', () => {
    expect(exposedParser.detect({ path: 'User.kt', text: 'import jakarta.persistence.*\n@Entity class User' })).toBe(false);
    expect(exposedParser.detect({ path: 'Svc.kt', text: 'class Service { fun doIt() {} }' })).toBe(false);
  });
});

describe('exposedParser – tables and columns', () => {
  it('reads IntIdTable id, column names, types, nullability, unique, defaults, autoIncrement', () => {
    const text = `
import org.jetbrains.exposed.dao.id.IntIdTable
import org.jetbrains.exposed.sql.ReferenceOption

object Users : IntIdTable("users") {
    val name = varchar("name", 50).uniqueIndex()
    val bio = text("bio").nullable()
    val age = integer("age").default(0)
    val active = bool("is_active").default(true)
    val score = decimal("score", 10, 2).nullable()
}`;
    const r = parse('Users.kt', text);
    expect(r.entities).toHaveLength(1);
    const e = r.entities[0];
    expect(e).toMatchObject({ name: 'users', modelName: 'Users', nameCertainty: 2 });
    expect(cols(e)).toEqual(['id', 'name', 'bio', 'age', 'is_active', 'score']);
    expect(e.columns[0]).toMatchObject({ name: 'id', type: 'integer', primaryKey: true, nullable: false, generated: true });
    expect(e.columns[1]).toMatchObject({ name: 'name', type: 'varchar(50)', nullable: false, unique: true });
    expect(e.columns[2]).toMatchObject({ name: 'bio', type: 'text', nullable: true });
    expect(e.columns[3]).toMatchObject({ name: 'age', default: '0' });
    expect(e.columns[4]).toMatchObject({ name: 'is_active', type: 'bool', default: 'true' });
    expect(e.columns[5]).toMatchObject({ name: 'score', type: 'decimal(10, 2)', nullable: true });
  });

  it('derives the default table name by stripping a trailing "Table" (certainty 0)', () => {
    const r = parse('Cities.kt', 'object CitiesTable : LongIdTable() {\n val name = varchar("name", 100)\n}');
    expect(r.entities[0]).toMatchObject({ name: 'Cities', modelName: 'CitiesTable', nameCertainty: 0 });
    expect(r.entities[0].columns[0]).toMatchObject({ name: 'id', type: 'long' });
  });

  it('handles plain Table() with an explicit composite primary key', () => {
    const text = `
object StarWarsFilms : Table() {
    val sequelId = integer("sequel_id").uniqueIndex()
    val name = varchar("name", 50)
    val director = varchar("director", 50)
    override val primaryKey = PrimaryKey(sequelId, name = "PK_StarWarsFilms")
}`;
    const r = parse('Films.kt', text);
    const e = r.entities[0];
    expect(e).toMatchObject({ name: 'StarWarsFilms', nameCertainty: 0 });
    expect(cols(e)).toEqual(['sequel_id', 'name', 'director']); // no implicit id for plain Table
    expect(e.columns.find((c) => c.name === 'sequel_id')).toMatchObject({ primaryKey: true, nullable: false });
  });

  it('parses enumerationByName columns and emits the enum', () => {
    const text = `
enum class Status { ACTIVE, BANNED }
object Accounts : IntIdTable("accounts") {
    val status = enumerationByName("status", 10, Status::class)
}`;
    const r = parse('Accounts.kt', text);
    expect(r.enums).toEqual([expect.objectContaining({ name: 'Status', values: ['ACTIVE', 'BANNED'] })]);
    expect(r.entities[0].columns.find((c) => c.name === 'status')).toMatchObject({ type: 'Status', enumRef: 'Status' });
  });

  it('reads init { } indexes', () => {
    const text = `
object Events : IntIdTable("events") {
    val userId = integer("user_id")
    val createdAt = long("created_at")
    init {
        index(false, userId)
        uniqueIndex(userId, createdAt)
    }
}`;
    const r = parse('Events.kt', text);
    expect(r.entities[0].indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ columns: ['user_id'], unique: false }),
        expect.objectContaining({ columns: ['user_id', 'created_at'], unique: true }),
      ]),
    );
  });
});

describe('exposedParser – references (end to end)', () => {
  it('links reference / optReference to the target table with onDelete', () => {
    const text = `
import org.jetbrains.exposed.dao.id.IntIdTable
import org.jetbrains.exposed.sql.ReferenceOption

object Cities : IntIdTable("cities") {
    val name = varchar("name", 50)
}

object Users : IntIdTable("users") {
    val name = varchar("name", 50)
    val city = reference("city_id", Cities, onDelete = ReferenceOption.CASCADE)
    val manager = optReference("manager_id", Users)
}`;
    const r = resolveSchema([fr('Schema.kt', text)]);
    expect(r.entities.map((e) => e.id).sort()).toEqual(['cities', 'users']);
    const users = r.entities.find((e) => e.id === 'users')!;
    expect(cols(users)).toEqual(expect.arrayContaining(['id', 'name', 'city_id', 'manager_id']));

    const cityRel = r.relations.find((x) => x.fromColumns[0] === 'city_id')!;
    expect(cityRel).toMatchObject({ from: 'users', to: 'cities', cardinality: 'many-to-one', optional: false, onDelete: 'CASCADE' });
    const mgrRel = r.relations.find((x) => x.fromColumns[0] === 'manager_id')!;
    expect(mgrRel).toMatchObject({ from: 'users', to: 'users', optional: true });
  });

  it('resolves `reference("x", Other.id)` referencing a specific column', () => {
    const text = `
object Other : LongIdTable("other") { val code = varchar("code", 20).uniqueIndex() }
object Thing : IntIdTable("thing") {
    val ref = reference("other_id", Other.id)
}`;
    const r = resolveSchema([fr('S.kt', text)]);
    const rel = r.relations.find((x) => x.fromColumns[0] === 'other_id')!;
    expect(rel).toMatchObject({ from: 'thing', to: 'other' });
  });
});

describe('exposedParser – robustness', () => {
  it('ignores DAO entity classes and never throws', () => {
    const text = `
object Users : IntIdTable("users") { val name = varchar("name", 50) }
class User(id: EntityID<Int>) : IntEntity(id) {
    companion object : IntEntityClass<User>(Users)
    var name by Users.name
}`;
    const r = parse('User.kt', text);
    expect(r.entities.map((e) => e.modelName)).toEqual(['Users']); // the DAO class is skipped
    for (const bad of ['object X : IntIdTable(', 'object : Table()', 'object Y : IntIdTable("y") { val a = varchar(', '']) {
      expect(() => parse('B.kt', bad)).not.toThrow();
    }
  });
});

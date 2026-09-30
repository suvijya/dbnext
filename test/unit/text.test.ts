import { describe, expect, it } from 'vitest';
import {
  Code,
  LineIndex,
  boolValue,
  cleanComment,
  lineOf,
  numberValue,
  splitQualified,
  stringValue,
  unquoteIdent,
  type Lang,
} from '../../src/core/text';

function code(text: string, lang: Lang): Code {
  const c = new Code(text, lang);
  // Invariant: every view has the same length and line breaks.
  expect(c.stripped.length).toBe(text.length);
  expect(c.masked.length).toBe(text.length);
  expect(c.stripped.split('\n').length).toBe(text.split('\n').length);
  expect(c.masked.split('\n').length).toBe(text.split('\n').length);
  return c;
}

describe('Code views per language', () => {
  it('js: comments vs strings, template literals, regex damage limited to a line', () => {
    const src = [
      'const a = "// not a comment"; // real comment',
      "const b = '/* no */'; /* yes */ const c = 1;",
      'const s = `a ${ f("}") + `x${1}` } b`; const after = 2;',
      "const r = /'/; const nextLine = 3;",
      'const ok = 4;',
    ].join('\n');
    const c = code(src, 'js');
    expect(c.stripped).toContain('"// not a comment"');
    expect(c.stripped).not.toContain('real comment');
    expect(c.stripped).toContain("'/* no */'");
    expect(c.stripped).not.toContain('/* yes */');
    expect(c.masked).not.toContain('not a comment');
    expect(c.masked).toContain('const c = 1;');
    expect(c.masked).toContain('const after = 2;');
    expect(c.masked).not.toContain('f(');
    expect(c.masked).toContain('const ok = 4;');
  });

  it('python: triple quotes, hashes inside strings', () => {
    const src = 'class A:\n    """Doc with \'quote" and # hash."""\n    x = "#nope"  # yes\n';
    const c = code(src, 'python');
    expect(c.masked).not.toContain('hash');
    expect(c.stripped).toContain('"#nope"');
    expect(c.stripped).not.toContain('# yes');
  });

  it('sql: doubled quotes, dollar quoting, E-strings, quoted identifiers', () => {
    const src = [
      "INSERT INTO t VALUES ('it''s -- not a comment'); -- comment",
      'CREATE FUNCTION f() RETURNS void AS $$ BEGIN; -- inside; END $$ LANGUAGE plpgsql;',
      "SELECT $fn$ ; $fn$, E'a\\'b;', \"we\"\"ird;\", `back;tick`; /* block; */ SELECT 1;",
    ].join('\n');
    const c = code(src, 'sql');
    expect(c.stripped).toContain("'it''s -- not a comment'");
    expect(c.stripped).not.toContain('-- comment');
    const statements = c.split(0, src.length, ';').map((s) => s.text.split(/\s+/)[0]);
    expect(statements).toEqual(['INSERT', 'CREATE', 'SELECT', 'SELECT']);
  });

  it('sql: optional MySQL backslash escapes', () => {
    const src = "COMMENT 'user\\'s email'; CREATE TABLE x (a int);";
    const plain = new Code(src, 'sql');
    const mysql = new Code(src, 'sql', { backslashEscapes: true });
    expect(mysql.split(0, src.length, ';').length).toBe(2);
    expect(plain.split(0, src.length, ';').length).toBeLessThan(2);
  });

  it('ruby: heredocs, =begin blocks, %w literals, interpolation, comments', () => {
    const src = [
      'execute <<~SQL',
      '  CREATE TABLE ghost (a int); -- "unbalanced',
      'SQL',
      '=begin',
      'create_table :ghost2',
      '=end',
      'create_table "users", force: :cascade do |t| # comment',
      '  t.string "role", default: "a#{x + "}"}b"',
      '  validates :kind, inclusion: { in: %w[a" b] }',
      'end',
    ].join('\n');
    const c = code(src, 'ruby');
    expect(c.masked).not.toContain('ghost');
    expect(c.stripped).toContain('create_table "users", force: :cascade do |t|');
    expect(c.masked).toContain('create_table "     ", force: :cascade do |t|');
    expect(c.masked).not.toContain('# comment');
    expect(c.masked).toContain('validates :kind, inclusion: { in: %w[');
    expect(c.masked).toMatch(/\n {2}t\.string " {4}", default: " +"\n/);
    expect(c.lineAt(src.indexOf('end', src.length - 4))).toBe(9);
  });

  it('ruby: `<<` append is not a heredoc', () => {
    const c = code('list << item\nlist <<other\nx = "ok"', 'ruby');
    expect(c.masked).toContain('x = "  "');
  });

  it('php: # comments but #[attributes], heredoc', () => {
    const src = [
      '#[ORM\\Entity] # comment',
      "$sql = <<<SQL",
      '  CREATE TABLE ghost ("x);',
      '  SQL;',
      "$table->string('name'); // done",
    ].join('\n');
    const c = code(src, 'php');
    expect(c.stripped).toContain('#[ORM\\Entity]');
    expect(c.stripped).not.toContain('# comment');
    expect(c.masked).not.toContain('ghost');
    expect(c.masked).toContain("$table->string('    ');");
  });

  it('rust: lifetimes, chars, raw strings, nested comments', () => {
    const src = "fn f<'a>(x: &'a str) -> char { '\\'' } /* a /* b */ c */ let r = r#\"raw \"q\" }\"#; let z = '}';\nafter();";
    const c = code(src, 'rust');
    expect(c.masked).toContain("fn f<'a>(x: &'a str) -> char {");
    expect(c.masked).not.toContain(' c */');
    expect(c.masked).not.toContain('raw');
    expect(c.masked).toContain('after();');
    const open = src.indexOf('{');
    expect(c.closing(open)).toBe(src.indexOf('}', src.indexOf("'\\''")));
  });

  it('csharp: verbatim and raw strings', () => {
    const src = 'var s = @"C:\\dir\\"; var t = "x // y"; // c\nvar raw = """ a "quoted" } """; var after = 1;';
    const c = code(src, 'csharp');
    expect(c.masked).toContain('var t = "      ";');
    expect(c.masked).not.toContain('// c');
    expect(c.masked).toContain('var after = 1;');
  });

  it('go: backtick struct tags survive stripping', () => {
    const src = 'type User struct {\n  Name string `gorm:"column:name;not null"` // c\n}';
    const c = code(src, 'go');
    expect(c.stripped).toContain('`gorm:"column:name;not null"`');
    expect(c.stripped).not.toContain('// c');
    expect(c.closing(src.indexOf('{'))).toBe(src.length - 1);
  });

  it('elixir: sigils, heredocs, comments', () => {
    const src = 'field :tags, {:array, :string}, default: ~w(a) # c\n@doc """\n# not a comment )\n"""\nfield :x';
    const c = code(src, 'elixir');
    expect(c.stripped).not.toContain('# c');
    expect(c.masked).not.toContain('not a comment');
    expect(c.masked).toContain('field :x');
  });

  it('kotlin: nested block comments and text blocks', () => {
    const src = 'val a = 1 /* x /* y */ z */ val b = """ { """ ; val c = 3';
    const c = code(src, 'kotlin');
    expect(c.masked).not.toContain('z */');
    expect(c.masked).toContain('val c = 3');
  });

  it('dbml: triple-quoted notes and backtick expressions', () => {
    const src = "Table users {\n  id int [pk, note: '''multi\n  line } ''']\n  created timestamp [default: `now()`]\n}";
    const c = code(src, 'dbml');
    expect(c.closing(src.indexOf('{'))).toBe(src.length - 1);
  });
});

describe('Code structure helpers', () => {
  it('closing ignores brackets in strings and comments', () => {
    const src = 'f(a, "(", g(b) /* ) */, [1, 2])';
    expect(code(src, 'js').closing(1)).toBe(src.length - 1);
  });

  it('closing supports generics and ignores arrows', () => {
    const src = 'Map<String, List<() -> User>> x';
    expect(code(src, 'kotlin').closing(3)).toBe(src.indexOf('>>') + 1);
  });

  it('items splits on top-level commas only', () => {
    const src = 'f(a, "x,y", g(b, c), [1, 2], {k: 1, j: 2}, )';
    expect(code(src, 'js').items(1).map((s) => s.text)).toEqual(['a', '"x,y"', 'g(b, c)', '[1, 2]', '{k: 1, j: 2}']);
  });

  it('split with angle brackets keeps generic types together', () => {
    const src = 'Map<String, Integer> a, List<User> b';
    expect(code(src, 'java').split(0, src.length, ',', { angle: true }).map((s) => s.text)).toEqual([
      'Map<String, Integer> a',
      'List<User> b',
    ]);
  });

  it('args: python keywords', () => {
    const src = 'Column("id", Integer, primary_key=True, default=lambda: x == 1)';
    const a = code(src, 'python').args(src.indexOf('('));
    expect(a.positional.map((p) => p.text)).toEqual(['"id"', 'Integer']);
    expect(a.named.get('primary_key')?.text).toBe('True');
    expect(a.named.get('default')?.text).toBe('lambda: x == 1');
    expect(a.end).toBe(src.length);
  });

  it('args: java annotation, csharp attribute, prisma attribute', () => {
    const j = '@Column(name = "email", nullable = false)';
    expect(code(j, 'java').args(j.indexOf('(')).named.get('name')?.text).toBe('"email"');
    const cs = '[Table("blogs", Schema = "blogging")] [Foo(name: "x")]';
    const csc = code(cs, 'csharp');
    expect(csc.args(cs.indexOf('(')).named.get('Schema')?.text).toBe('"blogging"');
    expect(csc.args(cs.lastIndexOf('(')).named.get('name')?.text).toBe('"x"');
    const p = '@relation(fields: [authorId], references: [id], onDelete: Cascade)';
    const pa = code(p, 'prisma').args(p.indexOf('('));
    expect(pa.named.get('fields')?.text).toBe('[authorId]');
    expect(pa.named.get('onDelete')?.text).toBe('Cascade');
  });

  it('argsIn + statementEnd: paren-less ruby call spanning lines', () => {
    const src = 't.references :user, null: false,\n  foreign_key: { to_table: :users }, :limit => 8\nt.string :next\n';
    const c = code(src, 'ruby');
    const start = src.indexOf(':user');
    const end = c.statementEnd(start);
    expect(src.slice(end, end + 1)).toBe('\n');
    expect(c.lineAt(end)).toBe(1);
    const a = c.argsIn(start, end);
    expect(a.positional.map((p) => p.text)).toEqual([':user']);
    expect(a.named.get('null')?.text).toBe('false');
    expect(a.named.get('foreign_key')?.text).toBe('{ to_table: :users }');
    expect(a.named.get('limit')?.text).toBe('8');
  });

  it('statementEnd: python call with open brackets, and enclosing bracket', () => {
    const src = 'x = Column(\n    String,\n    nullable=False)\ny = 1';
    const c = code(src, 'python');
    expect(c.statementEnd(0)).toBe(src.indexOf('\ny'));
    const inner = 'f(a, b)';
    expect(code(inner, 'python').statementEnd(2)).toBe(inner.length - 1);
  });

  it('args: php arrays with rockets', () => {
    const src = "['type' => 'string', \"length\" => 255, 'x']";
    const a = code(src, 'php').args(0);
    expect(a.named.get('type')?.text).toBe("'string'");
    expect(a.named.get('length')?.text).toBe('255');
    expect(a.positional.map((p) => p.text)).toEqual(["'x'"]);
  });

  it('object parses JS object literals', () => {
    const src = "{ name: 'x', \"quoted\": 1, 'single': 2, short, ...spread, method() {}, [computed]: 3, nested: { a: 1 } }";
    const o = code(src, 'js').object(0);
    expect([...o.keys()]).toEqual(['name', 'quoted', 'single', 'short', 'nested']);
    expect(o.get('nested')?.text).toBe('{ a: 1 }');
  });

  it('indentedBlock: python class bodies', () => {
    const src = [
      'class User(',
      '    Base,',
      '):',
      '    """Doc.',
      '',
      'more"""',
      '    __tablename__ = "users"',
      '# odd comment',
      '',
      '    id = Column(Integer)',
      'x = 1',
    ].join('\n');
    const c = code(src, 'python');
    const b = c.indentedBlock(0, 2);
    expect(b.startLine).toBe(3);
    expect(b.endLine).toBe(9);
    expect(c.slice(b.start, b.end)).toContain('id = Column(Integer)');
    expect(c.slice(b.start, b.end)).not.toContain('x = 1');
  });

  it('indentedBlock: ruby do…end excludes the end line; empty body', () => {
    const src = 'create_table :a do |t|\n  t.string :x\nend\nclass B; end\n';
    const c = code(src, 'ruby');
    expect(c.indentedBlock(0).endLine).toBe(1);
    const empty = c.indentedBlock(3);
    expect(empty.endLine).toBe(3);
    expect(empty.start).toBe(empty.end);
  });

  it('leadingComments returns directly preceding doc comments', () => {
    const src = [
      'model User {',
      '  /// The email',
      '  /// must be unique',
      '  email String @unique // trailing',
      '  // detached',
      '',
      '  name String',
      '}',
    ].join('\n');
    const c = code(src, 'prisma');
    expect(c.leadingComments(src.indexOf('email String'))).toEqual(['/// The email', '/// must be unique']);
    expect(c.leadingComments(src.indexOf('name String'))).toEqual([]);
  });

  it('lineAt / LineIndex / lineOf agree', () => {
    const src = 'a\nbb\r\nccc\n';
    const li = new LineIndex(src);
    for (let i = 0; i < src.length; i++) expect(li.lineAt(i)).toBe(lineOf(src, i));
    expect(li.lineCount).toBe(4);
    expect(src.slice(li.lineStart(2), li.lineEnd(2))).toBe('ccc');
    expect(new Code(src, 'sql').line(1)).toBe('bb');
  });

  it('isCode / inString / inComment', () => {
    const src = 'a "b" // c';
    const c = code(src, 'js');
    expect(c.isCode(0)).toBe(true);
    expect(c.inString(3)).toBe(true);
    expect(c.isCode(3)).toBe(false);
    expect(c.isCode(2)).toBe(true);
    expect(c.inComment(8)).toBe(true);
  });
});

describe('literal helpers', () => {
  it('stringValue', () => {
    expect(stringValue('"users"')).toBe('users');
    expect(stringValue(" 'users' ")).toBe('users');
    expect(stringValue('`users`')).toBe('users');
    expect(stringValue('`a${b}`')).toBeUndefined();
    expect(stringValue('r"x\\y"')).toBe('x\\y');
    expect(stringValue('f"x"')).toBe('x');
    expect(stringValue('@"C:\\x"')).toBe('C:\\x');
    expect(stringValue("N'x'")).toBe('x');
    expect(stringValue(':sym')).toBe('sym');
    expect(stringValue(':"a b"')).toBe('a b');
    expect(stringValue('"a" + "b"')).toBeUndefined();
    expect(stringValue("'it''s'")).toBe("it's");
    expect(stringValue('"a\\"b"')).toBe('a"b');
    expect(stringValue('"""doc"""')).toBe('doc');
    expect(stringValue('123')).toBeUndefined();
    expect(stringValue(undefined)).toBeUndefined();
  });

  it('boolValue / numberValue', () => {
    expect(boolValue('True')).toBe(true);
    expect(boolValue(' false ')).toBe(false);
    expect(boolValue('nil')).toBeUndefined();
    expect(numberValue('255')).toBe(255);
    expect(numberValue('1_000')).toBe(1000);
    expect(numberValue('x')).toBeUndefined();
  });

  it('unquoteIdent / splitQualified', () => {
    expect(unquoteIdent('"a""b"')).toBe('a"b');
    expect(unquoteIdent('[x]')).toBe('x');
    expect(unquoteIdent('`x`')).toBe('x');
    expect(unquoteIdent(' plain ')).toBe('plain');
    expect(splitQualified('"public"."Users"')).toEqual(['public', 'Users']);
    expect(splitQualified('[dbo].[my.table]')).toEqual(['dbo', 'my.table']);
    expect(splitQualified('a.b.c')).toEqual(['a', 'b', 'c']);
  });

  it('cleanComment', () => {
    expect(cleanComment('/**\n * A\n * B\n */')).toBe('A\nB');
    expect(cleanComment('/// doc')).toBe('doc');
    expect(cleanComment('# x')).toBe('x');
    expect(cleanComment('-- y')).toBe('y');
  });
});

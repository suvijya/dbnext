import { describe, expect, it } from 'vitest';
import { doctrineParser } from '../../../src/parsers/doctrine';

const parse = (text: string) => doctrineParser.parse({ path: 'src/Entity/E.php', text });

describe('doctrine edge cases', () => {
  // Performance regression: assignMetas (members.find per meta) and lineOf (scan-from-start per
  // member) were both O(n²); a ~0.7 MB entity catalogue took ~1.6 s – over the 1.5 s/file budget.
  it('parses a large single-file entity catalogue in roughly linear time', () => {
    const unit = [
      '#[ORM\\Entity]',
      "#[ORM\\Table(name: 'posts')]",
      'class Post {',
      '  #[ORM\\Id] #[ORM\\GeneratedValue] #[ORM\\Column] private ?int $id = null;',
      "  #[ORM\\ManyToOne(targetEntity: User::class)] #[ORM\\JoinColumn(name: 'author_id')] private ?User $author = null;",
      "  #[ORM\\Column(type: 'string', length: 255)] private string $title;",
      '}',
    ].join('\n');
    const text = '<?php\nnamespace App;\nuse Doctrine\\ORM\\Mapping as ORM;\n' + Array(2000).fill(unit).join('\n');
    expect(text.length).toBeGreaterThan(500_000);
    const t = Date.now();
    const r = parse(text);
    const ms = Date.now() - t;
    expect(r.entities.length).toBe(2000);
    expect(ms).toBeLessThan(1500); // was ~1.6 s before the fix; linear fix brings it to tens of ms
  });

  it('reads attributes split over multiple lines (common php-cs-fixer formatting)', () => {
    const text = [
      '<?php',
      'namespace App\\Entity;',
      'use Doctrine\\ORM\\Mapping as ORM;',
      '',
      '#[ORM\\Entity]',
      "#[ORM\\Table(name: 'comments')]",
      'class Comment',
      '{',
      '    #[ORM\\Id]',
      '    #[ORM\\GeneratedValue]',
      '    #[ORM\\Column]',
      '    private ?int $id = null;',
      '',
      '    #[ORM\\ManyToOne(',
      '        targetEntity: Post::class,',
      "        inversedBy: 'comments',",
      '    )]',
      '    #[ORM\\JoinColumn(',
      "        name: 'post_id',",
      "        referencedColumnName: 'id',",
      '        nullable: false,',
      '    )]',
      '    private ?Post $post = null;',
      '}',
    ].join('\n');
    const r = parse(text);
    const comment = r.entities.find((e) => e.modelName === 'Comment')!;
    expect(comment.name).toBe('comments');
    expect(comment.columns.map((c) => c.name)).toEqual(['id', 'post_id']);
    const rel = r.relations.find((x) => x.fromColumns[0] === 'post_id')!;
    expect(rel).toMatchObject({ to: { model: 'Post' }, cardinality: 'many-to-one', optional: false });
  });
});

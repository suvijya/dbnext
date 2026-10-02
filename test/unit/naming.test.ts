import { describe, expect, it } from 'vitest';
import {
  camelCase,
  defaultTableName,
  naturalCompare,
  pascalCase,
  pluralize,
  shortName,
  singularize,
  snakeCase,
  words,
} from '../../src/core/naming';

describe('case conversion', () => {
  it('words', () => {
    expect(words('userProfileID')).toEqual(['user', 'Profile', 'ID']);
    expect(words('HTTPServer')).toEqual(['HTTP', 'Server']);
    expect(words('order_items')).toEqual(['order', 'items']);
    expect(words('md5Hash')).toEqual(['md5', 'Hash']);
    expect(words('user-profile')).toEqual(['user', 'profile']);
  });

  it('snake / camel / pascal', () => {
    expect(snakeCase('UserProfile')).toBe('user_profile');
    expect(snakeCase('userID')).toBe('user_id');
    expect(snakeCase('MD5Hash')).toBe('md5_hash');
    expect(snakeCase('already_snake')).toBe('already_snake');
    expect(camelCase('user_profile_id')).toBe('userProfileId');
    expect(pascalCase('user_profile')).toBe('UserProfile');
  });
});

describe('inflection', () => {
  const pairs: [string, string][] = [
    ['user', 'users'],
    ['category', 'categories'],
    ['person', 'people'],
    ['child', 'children'],
    ['box', 'boxes'],
    ['address', 'addresses'],
    ['status', 'statuses'],
    ['bus', 'buses'],
    ['quiz', 'quizzes'],
    ['wolf', 'wolves'],
    ['half', 'halves'],
    ['knife', 'knives'],
    ['analysis', 'analyses'],
    ['medium', 'media'],
    ['matrix', 'matrices'],
    ['index', 'indices'],
    ['mouse', 'mice'],
    ['ox', 'oxen'],
    ['series', 'series'],
    ['news', 'news'],
    ['equipment', 'equipment'],
    ['woman', 'women'],
    ['salesperson', 'salespeople'],
    ['hero', 'heros'],
    ['movie', 'movies'],
    ['cookie', 'cookies'],
    ['archive', 'archives'],
    ['database', 'databases'],
    ['branch', 'branches'],
    ['wish', 'wishes'],
  ];

  it.each(pairs)('pluralize(%s) = %s', (s, p) => {
    expect(pluralize(s)).toBe(p);
  });

  it.each(pairs.filter(([s]) => s !== 'hero'))('singularize(%s) ← %s', (s, p) => {
    expect(singularize(p)).toBe(s);
  });

  it('does not singularize already singular words', () => {
    for (const w of ['user', 'status', 'address', 'bus', 'news', 'analysis', 'campus', 'class', 'axis']) {
      expect(singularize(w)).toBe(w);
    }
    expect(pluralize('users')).toBe('users');
  });

  it('singularizes plurals ending in -is / -us but keeps singular -us / -sis words', () => {
    expect(singularize('custom_emojis')).toBe('custom_emoji');
    expect(singularize('apis')).toBe('api');
    expect(singularize('menus')).toBe('menu');
    expect(singularize('skus')).toBe('sku');
    expect(singularize('kiwis')).toBe('kiwi');
    for (const w of ['status', 'campus', 'bus', 'virus', 'bonus', 'analysis', 'basis', 'class']) expect(singularize(w), w).toBe(w);
    expect(singularize('statuses')).toBe('status');
    expect(singularize('campuses')).toBe('campus');
  });

  it('keeps regular words that merely end in "man"', () => {
    expect(pluralize('human')).toBe('humans');
    expect(pluralize('german')).toBe('germans');
    expect(pluralize('chairman')).toBe('chairmen');
    expect(pluralize('mongoose')).toBe('mongooses');
  });

  it('inflects only the last word and preserves case', () => {
    expect(pluralize('UserProfile')).toBe('UserProfiles');
    expect(pluralize('order_item')).toBe('order_items');
    expect(pluralize('Person')).toBe('People');
    expect(pluralize('PERSON')).toBe('PEOPLE');
    expect(pluralize('BlogCategory')).toBe('BlogCategories');
    expect(singularize('user_profiles')).toBe('user_profile');
    expect(singularize('OrderItems')).toBe('OrderItem');
    expect(singularize('Categories')).toBe('Category');
    expect(singularize('caches')).toBe('cache');
    expect(singularize('ties')).toBe('tie');
    expect(singularize('parties')).toBe('party');
  });

  it('mongoose flavor', () => {
    expect(pluralize('status', 'mongoose')).toBe('status');
    expect(pluralize('status')).toBe('statuses');
  });
});

describe('ORM conventions', () => {
  it('shortName', () => {
    expect(shortName('App\\Models\\User')).toBe('User');
    expect(shortName('auth.User')).toBe('User');
    expect(shortName('Admin::User')).toBe('User');
    expect(shortName('com.acme.User')).toBe('User');
    expect(shortName("'User'")).toBe('User');
    expect(shortName('User')).toBe('User');
  });

  it('defaultTableName', () => {
    expect(defaultTableName('rails', 'UserProfile')).toBe('user_profiles');
    expect(defaultTableName('rails', 'Person')).toBe('people');
    expect(defaultTableName('laravel', 'App\\Models\\BlogPost')).toBe('blog_posts');
    expect(defaultTableName('gorm', 'UserProfile')).toBe('user_profiles');
    expect(defaultTableName('sequelize', 'UserProfile')).toBe('UserProfiles');
    expect(defaultTableName('mongoose', 'UserProfile')).toBe('userprofiles');
    expect(defaultTableName('mongoose', 'Person')).toBe('people');
    expect(defaultTableName('typeorm', 'UserProfile')).toBe('user_profile');
    expect(defaultTableName('jpa', 'UserProfile')).toBe('user_profile');
    expect(defaultTableName('django', 'UserProfile', { appLabel: 'accounts' })).toBe('accounts_userprofile');
    expect(defaultTableName('sqlmodel', 'UserProfile')).toBe('userprofile');
    expect(defaultTableName('prisma', 'UserProfile')).toBe('UserProfile');
    expect(defaultTableName('efcore', 'UserProfile')).toBe('UserProfile');
  });

  it('naturalCompare orders migrations chronologically', () => {
    const files = ['V10__x.sql', 'V2__b.sql', 'V1__a.sql', '20240101_a.rb', '20231231_z.rb', '0002_b.py', '0010_c.py'];
    expect([...files].sort(naturalCompare)).toEqual([
      '0002_b.py',
      '0010_c.py',
      '20231231_z.rb',
      '20240101_a.rb',
      'V1__a.sql',
      'V2__b.sql',
      'V10__x.sql',
    ]);
  });
});

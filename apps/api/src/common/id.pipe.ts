import type { PipeTransform } from '@nestjs/common';
import { notFound } from './errors.js';

/** Route ids: a positive int4, anything else is a 404 (not a 400 or a 500 from Postgres). */
export class IdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (!/^[1-9]\d{0,9}$/.test(value)) throw notFound();
    const id = Number(value);
    if (id > 2_147_483_647) throw notFound();
    return id;
  }
}

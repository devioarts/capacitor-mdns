import { WebPlugin } from '@capacitor/core';

import type { mDNSPlugin } from './definitions';

export class mDNSWeb extends WebPlugin implements mDNSPlugin {
  async echo(options: { value: string }): Promise<{ value: string }> {
    console.log('ECHO', options);
    return options;
  }
}

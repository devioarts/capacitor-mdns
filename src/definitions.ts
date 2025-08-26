export interface mDNSPlugin {
  echo(options: { value: string }): Promise<{ value: string }>;
}

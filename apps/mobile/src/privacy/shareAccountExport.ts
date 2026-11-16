import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import type { MobileAccountExportArtifact } from './accountPrivacy';

/**
 * Hand a data export to the OS share sheet.
 *
 * Mirrors downloadRunnerFile.ts deliberately: that route is proven on both
 * platforms (iOS build 35, confirmed by Alex) and it means the export lands
 * wherever the reader already keeps things, rather than us inventing a file
 * browser. The bundle arrives as JSON in memory, so unlike a runner file it
 * is written to cache first and then shared.
 *
 * expo-file-system's SDK 55 API is used here (File + Paths); the legacy
 * writeAsStringAsync helpers were removed in that upgrade and using them is
 * what broke the first version of the download feature.
 */
export async function shareAccountExport(artifact: MobileAccountExportArtifact): Promise<void> {
  const name = safeExportFileName(artifact.fileName);
  const file = new FileSystem.File(FileSystem.Paths.cache, name);
  file.write(JSON.stringify(artifact.bundle, null, 2));

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('sharing_unavailable');
  }
  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/json',
    dialogTitle: 'Your Delegent AI data',
    UTI: 'public.json',
  });
}

/** Strip anything path-like; the server names the file but we own the disk. */
function safeExportFileName(name: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  const withExt = cleaned.toLowerCase().endsWith('.json') ? cleaned : `${cleaned || 'delegent-export'}.json`;
  return withExt.slice(-120);
}

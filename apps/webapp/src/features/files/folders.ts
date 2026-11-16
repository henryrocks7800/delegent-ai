import type { RunnerFile } from './filesApi';

// Grouping, noise filtering and collapse state now come from @sidekick/shared,
// so the same workspace draws the same folders here and on the phone. What is
// left is the two path operations that are specific to the browser's row shape.

/** The base name, without the folder path the runner puts in front of it. */
export function displayName(file: RunnerFile): string {
  const path = file.relativeName ?? file.name;
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

// The directory exactly as the runner spells it. The shared helper lowercases,
// because it builds a grouping key; a rename has to put the file back where it
// came from, so it needs the original case.
function directoryOf(file: RunnerFile): string {
  const path = (file.relativeName ?? file.name).replace(/^\.\//, '').replace(/^\/+/, '');
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/** The same row wearing a new base name, for showing a rename before it lands. */
export function withRenamedPath(file: RunnerFile, newName: string): RunnerFile {
  const dir = directoryOf(file);
  const path = dir ? `${dir}/${newName}` : newName;
  // `name` carries the path when the runner sends no relativeName, so writing a
  // bare base name into it would move the row to the root for as long as the
  // optimistic rename is on screen.
  const next: RunnerFile = { ...file, name: file.relativeName === undefined ? path : newName };
  if (file.relativeName !== undefined) next.relativeName = path;
  return next;
}

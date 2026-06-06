export function buildContentDisposition(fileName: string): string {
  const fallback = asciiFallbackFileName(fileName);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987Value(fileName)}`;
}

function asciiFallbackFileName(fileName: string): string {
  const extension = pathExtension(fileName);
  const nameWithoutExtension = extension ? fileName.slice(0, -extension.length) : fileName;
  const safeName = nameWithoutExtension
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${safeName || 'artifact'}${extension}`;
}

function pathExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === fileName.length - 1) {
    return '';
  }
  const extension = fileName.slice(lastDot).replace(/[^A-Za-z0-9.]/g, '');
  return extension === '.' ? '' : extension;
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

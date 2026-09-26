import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Sanitiza nome de ficheiro para uso como chave em Supabase Storage.
 * Remove acentos, espaços, caracteres especiais (ç, parêntesis, etc.).
 */
export function sanitizeFilename(name: string): string {
  const dotIdx = name.lastIndexOf(".");
  const base = dotIdx >= 0 ? name.substring(0, dotIdx) : name;
  const ext = dotIdx >= 0 ? name.substring(dotIdx) : "";

  const cleanedBase = base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const cleanedExt = ext
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.]/g, "");

  return (cleanedBase || "file") + cleanedExt.toLowerCase();
}

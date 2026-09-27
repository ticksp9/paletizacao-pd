import { useState, useRef } from 'react';
import { Upload, FileSpreadsheet, CheckCircle, AlertTriangle, ArrowLeft } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialCard } from '@/components/ui/IndustrialCard';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
  supabase,
} from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { sanitizeFilename } from '@/lib/utils';

interface ImportReport {
  created: number;
  updated: number;
  errors: { row: number; ean: string; message: string }[];
  warnings: { row: number; ean: string; message: string }[];
  total_rows: number;
}

export default function ImportArticlesPage() {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setReport(null);
  };

  const handleImport = async () => {
    if (!file) return;
    setIsProcessing(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: 'Erro', description: 'Sessão expirada. Faça login novamente.', variant: 'destructive' });
        setIsProcessing(false);
        return;
      }

      const timestamp = Date.now();
      const storagePath = `imports/${timestamp}_${sanitizeFilename(file.name)}`;
      const { error: uploadError } = await supabase.storage
        .from('masterdata')
        .upload(storagePath, file);

      if (uploadError) {
        toast({ title: 'Erro', description: `Falha no upload: ${uploadError.message}`, variant: 'destructive' });
        setIsProcessing(false);
        return;
      }

      const url = `${SUPABASE_URL}/functions/v1/import-masterdata-items`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file_path: storagePath,
          file_name: file.name,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        toast({ title: 'Erro', description: result.error || 'Erro na importação', variant: 'destructive' });
        setIsProcessing(false);
        return;
      }

      setReport(result as ImportReport);
      toast({
        title: 'Importação concluída',
        description: `${result.created} criados, ${result.updated} atualizados, ${result.errors.length} erros`,
      });
    } catch {
      toast({ title: 'Erro', description: 'Falha na comunicação com o servidor', variant: 'destructive' });
    } finally {
      setIsProcessing(false);
    }
  };

  // Importar artigos altera dados mestre: só administradores.
  if (!isAdmin) return <Navigate to="/master/articles" replace />;

  return (
    <MainLayout
      title="Importar Artigos"
      subtitle="Excel/CSV: EAN, Designação, Peças/Cx., Peso caixa (kg) (ou peso/weight) e Medida das Caixas"
      actions={
        <IndustrialButton variant="ghost" icon={<ArrowLeft className="w-5 h-5" />} onClick={() => navigate('/master/articles')}>
          Voltar
        </IndustrialButton>
      }
    >
      <div className="max-w-4xl space-y-6">
        {/* Upload */}
        <IndustrialCard>
          <div className="flex items-center gap-4 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt,.tsv,.xlsx,.xls"
              onChange={handleFile}
              className="hidden"
            />
            <IndustrialButton variant="primary" icon={<Upload className="w-5 h-5" />} onClick={() => fileInputRef.current?.click()}>
              Selecionar Ficheiro
            </IndustrialButton>
            {file && (
              <>
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4" />
                  {file.name} ({(file.size / 1024).toFixed(1)} KB)
                </span>
                <IndustrialButton variant="primary" onClick={handleImport} disabled={isProcessing}>
                  {isProcessing ? 'A importar...' : 'Importar'}
                </IndustrialButton>
              </>
            )}
          </div>
        </IndustrialCard>

        {/* Report */}
        {report && (
          <IndustrialCard>
            <h3 className="font-semibold mb-4">Resumo da Importação</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              <div className="p-4 rounded-lg bg-muted/50 text-center">
                <p className="text-2xl font-bold">{report.total_rows}</p>
                <p className="text-sm text-muted-foreground">Total linhas</p>
              </div>
              <div className="p-4 rounded-lg bg-primary/10 text-center">
                <CheckCircle className="w-5 h-5 text-primary mx-auto mb-1" />
                <p className="text-2xl font-bold">{report.created}</p>
                <p className="text-sm text-muted-foreground">Criados</p>
              </div>
              <div className="p-4 rounded-lg bg-accent/50 text-center">
                <CheckCircle className="w-5 h-5 text-accent-foreground mx-auto mb-1" />
                <p className="text-2xl font-bold">{report.updated}</p>
                <p className="text-sm text-muted-foreground">Atualizados</p>
              </div>
              <div className="p-4 rounded-lg bg-destructive/10 text-center">
                <AlertTriangle className="w-5 h-5 text-destructive mx-auto mb-1" />
                <p className="text-2xl font-bold">{report.errors.length}</p>
                <p className="text-sm text-muted-foreground">Erros</p>
              </div>
            </div>

            {/* Warnings */}
            {report.warnings.length > 0 && (
              <div className="mb-4">
                <h4 className="text-sm font-medium mb-2 text-muted-foreground">Avisos ({report.warnings.length})</h4>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {report.warnings.map((w, i) => (
                    <p key={i} className="text-sm text-muted-foreground">
                      Linha {w.row} (EAN: {w.ean}): {w.message}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* Errors table */}
            {report.errors.length > 0 && (
              <>
                <h4 className="text-sm font-medium mb-2 text-destructive">Erros ({report.errors.length})</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Linha</TableHead>
                      <TableHead>EAN</TableHead>
                      <TableHead>Erro</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.errors.map((err, idx) => (
                      <TableRow key={idx}>
                        <TableCell>{err.row}</TableCell>
                        <TableCell className="font-mono text-sm">{err.ean || '-'}</TableCell>
                        <TableCell className="text-destructive">{err.message}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </IndustrialCard>
        )}
      </div>
    </MainLayout>
  );
}

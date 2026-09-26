import { useState, useCallback } from 'react';
import { Upload, FileText, CheckCircle2, AlertCircle, AlertTriangle, XCircle } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialCard, IndustrialCardHeader } from '@/components/ui/IndustrialCard';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { StepIndicator } from '@/components/ui/StepIndicator';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { useNavigate } from 'react-router-dom';
import { sanitizeFilename } from '@/lib/utils';

const steps = [
  { number: 1, label: 'Selecionar Ficheiro' },
  { number: 2, label: 'Processar EDI' },
  { number: 3, label: 'Resultado' },
];

interface ParseError {
  line: number;
  message: string;
}

interface CreatedOrder {
  id: string;
  order_number: string;
  customer_name: string | null;
  lines_count: number;
  order_date?: string | null;
  delivery_date?: string | null;
}

function formatPtDate(value?: string | null): string | null {
  if (!value) return null;
  const [y, m, d] = value.slice(0, 10).split('-');
  return y && m && d ? `${d}-${m}-${y}` : null;
}

interface ParseResult {
  success: boolean;
  orders: Array<{
    order_number: string;
    customer_name: string | null;
    lines: Array<{ article_code: string; quantity: number }>;
  }>;
  errors: ParseError[];
  warnings: ParseError[];
  created_orders?: CreatedOrder[];
  debug?: {
    warehouse_code_header: string | null;
    location_ids_found: string[];
    lines_without_location_id: number;
    line_location_ids: Array<{
      line_number: number;
      location_id: string | null;
    }>;
    lg_master_found: Array<{
      warehouse_code: string;
      location_id: string;
    }>;
    lg_master_missing: Array<{
      warehouse_code: string;
      location_id: string;
    }>;
  };
}

export default function ImportEDIPage() {
  const [currentStep, setCurrentStep] = useState(1);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setUploadError(null);
      setParseResult(null);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      setSelectedFile(file);
      setUploadError(null);
      setParseResult(null);
    }
  }, []);

  const handleUploadAndParse = async () => {
    if (!selectedFile || !user) return;

    setIsUploading(true);
    setUploadError(null);
    
    try {
      // 1. Upload to storage
      const filePath = `${user.id}/${Date.now()}_${sanitizeFilename(selectedFile.name)}`;
      const { error: uploadError } = await supabase.storage
        .from('edi-files')
        .upload(filePath, selectedFile);

      if (uploadError) throw new Error(`Erro no upload: ${uploadError.message}`);

      // 2. Create database record
      const { data: fileRecord, error: dbError } = await supabase
        .from('edi_files')
        .insert({
          filename: selectedFile.name,
          storage_path: filePath,
          file_size: selectedFile.size,
          status: 'processing',
          imported_by: user.id,
        })
        .select()
        .single();

      if (dbError) throw new Error(`Erro na base de dados: ${dbError.message}`);

      setCurrentStep(2);
      setIsUploading(false);
      setIsProcessing(true);

      // 3. Call parse-edi edge function
      const { data: parseData, error: parseError } = await supabase.functions
        .invoke('parse-edi', {
          body: {
            storage_path: filePath,
            edi_file_id: fileRecord.id,
          },
        });

      if (parseError) {
        throw new Error(`Erro no processamento: ${parseError.message}`);
      }

      setParseResult(parseData as ParseResult);
      setCurrentStep(3);

      if (parseData.created_orders?.length > 0) {
        toast({
          title: 'Importação concluída',
          description: `${parseData.created_orders.length} encomenda(s) criada(s) com sucesso.`,
        });
      }

    } catch (error) {
      const errorMessage = (error as Error).message;
      setUploadError(errorMessage);
      toast({
        title: 'Erro na importação',
        description: errorMessage,
        variant: 'destructive',
      });
      setCurrentStep(1);
    } finally {
      setIsUploading(false);
      setIsProcessing(false);
    }
  };

  const handleReset = () => {
    setCurrentStep(1);
    setSelectedFile(null);
    setParseResult(null);
    setUploadError(null);
  };

  const hasErrors = parseResult?.errors && parseResult.errors.length > 0;
  const hasWarnings = parseResult?.warnings && parseResult.warnings.length > 0;
  const hasCreatedOrders = parseResult?.created_orders && parseResult.created_orders.length > 0;
  const hasDebug = !!parseResult?.debug;
  const lgFoundCount = parseResult?.debug?.lg_master_found?.length || 0;
  const lgMissingCount = parseResult?.debug?.lg_master_missing?.length || 0;
  const missingLgList = Array.from(new Set((parseResult?.debug?.lg_master_missing || []).map((item) => item.location_id)));

  const handleOpenMissingLgForm = () => {
    const warehouse = parseResult?.debug?.warehouse_code_header || '';
    const missing = missingLgList.join(',');
    navigate(`/master/lg-locations?quickAdd=1&warehouse=${encodeURIComponent(warehouse)}&missing=${encodeURIComponent(missing)}`);
  };

  return (
    <MainLayout 
      title="Importar EDI" 
      subtitle="Carregar e processar ficheiros EDI para criar encomendas"
    >
      <StepIndicator steps={steps} currentStep={currentStep} />

      <div className="max-w-3xl mx-auto">
        {/* Step 1: Select File */}
        {currentStep === 1 && (
          <IndustrialCard className="animate-fade-in">
            <IndustrialCardHeader
              title="1. Selecionar Ficheiro EDI"
              subtitle="Formatos suportados: EDIFACT (.edi), CSV, ficheiros de texto"
              icon={<Upload className="w-5 h-5" />}
            />

            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              className="mt-4 border-2 border-dashed border-border rounded-xl p-12 text-center hover:border-primary/50 transition-colors cursor-pointer"
              onClick={() => document.getElementById('file-input')?.click()}
            >
              <input
                id="file-input"
                type="file"
                accept=".edi,.txt,.dat,.csv"
                onChange={handleFileSelect}
                className="hidden"
              />

              {selectedFile ? (
                <div className="flex flex-col items-center gap-4">
                  <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center">
                    <FileText className="w-8 h-8 text-success" />
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-foreground">{selectedFile.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {(selectedFile.size / 1024).toFixed(2)} KB
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4">
                  <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
                    <Upload className="w-8 h-8 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-lg font-medium text-foreground">
                      Arraste o ficheiro aqui
                    </p>
                    <p className="text-sm text-muted-foreground">
                      ou clique para selecionar (.edi, .txt, .csv, .dat)
                    </p>
                  </div>
                </div>
              )}
            </div>

            {uploadError && (
              <div className="mt-4 p-4 bg-destructive/10 rounded-lg border border-destructive/30">
                <div className="flex items-start gap-3">
                  <XCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-destructive">Erro no processamento</p>
                    <p className="text-sm text-destructive/80 mt-1">{uploadError}</p>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <IndustrialButton
                variant="primary"
                size="lg"
                onClick={handleUploadAndParse}
                isLoading={isUploading}
                disabled={!selectedFile}
                icon={<Upload className="w-5 h-5" />}
              >
                Carregar e Processar
              </IndustrialButton>
            </div>
          </IndustrialCard>
        )}

        {/* Step 2: Processing */}
        {currentStep === 2 && (
          <IndustrialCard className="animate-fade-in">
            <IndustrialCardHeader
              title="2. A Processar Ficheiro EDI"
              subtitle="A analisar e extrair encomendas..."
              icon={<FileText className="w-5 h-5" />}
            />

            <div className="mt-8 py-12 text-center">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-primary/10 animate-pulse mb-6">
                <FileText className="w-10 h-10 text-primary" />
              </div>
              <p className="text-lg font-medium text-foreground mb-2">
                A processar {selectedFile?.name}
              </p>
              <p className="text-muted-foreground">
                A extrair encomendas e linhas de produto...
              </p>
            </div>
          </IndustrialCard>
        )}

        {/* Step 3: Results */}
        {currentStep === 3 && parseResult && (
          <div className="space-y-4 animate-fade-in">
            {/* Success Summary */}
            {hasCreatedOrders && (
              <IndustrialCard variant="highlight">
                <div className="flex items-start gap-4">
                  <div className="w-14 h-14 rounded-xl bg-success/10 flex items-center justify-center flex-shrink-0">
                    <CheckCircle2 className="w-7 h-7 text-success" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-bold text-foreground">
                      {parseResult.created_orders!.length} Encomenda(s) Criada(s)
                    </h3>
                    <p className="text-muted-foreground mt-1">
                      As encomendas foram importadas com sucesso para o sistema.
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  {parseResult.created_orders!.map((order) => (
                    <div
                      key={order.id}
                      className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <CheckCircle2 className="w-5 h-5 text-success" />
                        <div>
                          <p className="font-semibold text-foreground">{order.order_number}</p>
                          <p className="text-sm text-muted-foreground">{order.customer_name || 'Cliente não especificado'}</p>
                          <p className="text-sm text-muted-foreground">
                            Data da encomenda: {formatPtDate(order.order_date) || 'não vem no XML'}
                            {' | '}
                            Data de entrega: {formatPtDate(order.delivery_date) || 'não vem no XML'}
                          </p>
                        </div>
                      </div>
                      <span className="text-sm font-medium text-muted-foreground">
                        {order.lines_count} linhas
                      </span>
                    </div>
                  ))}
                </div>
              </IndustrialCard>
            )}

            {/* Errors */}
            {hasErrors && (
              <IndustrialCard>
                <IndustrialCardHeader
                  title={`${parseResult.errors.length} Erro(s) Encontrado(s)`}
                  subtitle="Estes problemas impediram o processamento de algumas partes do ficheiro"
                  icon={<AlertCircle className="w-5 h-5 text-destructive" />}
                />
                <div className="mt-4 space-y-2 max-h-64 overflow-y-auto">
                  {parseResult.errors.map((error, index) => (
                    <div
                      key={index}
                      className="flex items-start gap-3 p-3 bg-destructive/5 rounded-lg border border-destructive/20"
                    >
                      <XCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                      <div>
                        {error.line > 0 && (
                          <span className="text-xs font-mono text-destructive/70 mr-2">
                            Linha {error.line}:
                          </span>
                        )}
                        <span className="text-sm text-foreground">{error.message}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </IndustrialCard>
            )}

            {/* Warnings */}
            {hasWarnings && (
              <IndustrialCard>
                <IndustrialCardHeader
                  title={`${parseResult.warnings.length} Aviso(s)`}
                  subtitle="Potenciais problemas que não impediram a importação"
                  icon={<AlertTriangle className="w-5 h-5 text-warning" />}
                />
                <div className="mt-4 space-y-2 max-h-48 overflow-y-auto">
                  {parseResult.warnings.map((warning, index) => (
                    <div
                      key={index}
                      className="flex items-start gap-3 p-3 bg-warning/5 rounded-lg border border-warning/20"
                    >
                      <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                      <div>
                        {warning.line > 0 && (
                          <span className="text-xs font-mono text-warning/70 mr-2">
                            Linha {warning.line}:
                          </span>
                        )}
                        <span className="text-sm text-foreground">{warning.message}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </IndustrialCard>
            )}

            {/* Debug de verificação LG no XML */}
            {hasDebug && (
              <IndustrialCard>
                <IndustrialCardHeader
                  title="Debug de verificação LG"
                  subtitle="Diagnóstico da extração de LocationID nas linhas do XML"
                  icon={<FileText className="w-5 h-5" />}
                />

                <div className="mt-4 space-y-4 text-sm">
                  <div className="p-3 bg-muted/50 rounded-lg">
                    <p className="font-medium text-foreground">Armazém lido do header</p>
                    <p className="text-muted-foreground mt-1">
                      {parseResult.debug?.warehouse_code_header || 'Não encontrado'}
                    </p>
                  </div>

                  <div className="p-3 bg-muted/50 rounded-lg">
                    <p className="font-medium text-foreground">LocationID encontrados no XML (únicos)</p>
                    {parseResult.debug?.location_ids_found?.length ? (
                      <div className="mt-1 space-y-1">
                        {parseResult.debug.location_ids_found.map((locId) => {
                          const count = parseResult.debug?.line_location_ids?.filter(
                            (l) => l.location_id === locId
                          ).length || 0;
                          return (
                            <p key={locId} className="text-muted-foreground">
                              <span className="font-mono font-semibold text-foreground">{locId}</span>
                              {' — '}{count} linha(s)
                            </p>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-muted-foreground mt-1">Nenhum LocationID encontrado nas linhas</p>
                    )}
                  </div>

                  <div className="p-3 bg-muted/50 rounded-lg">
                    <p className="font-medium text-foreground">Linhas sem LocationID</p>
                    <p className="text-muted-foreground mt-1">
                      {parseResult.debug?.lines_without_location_id ?? 0}
                    </p>
                  </div>

                  <div className="p-3 bg-muted/50 rounded-lg">
                    <p className="font-medium text-foreground">LGs no master data (company + warehouse + location)</p>
                    <p className="text-muted-foreground mt-1">
                      Encontrados: <span className="font-semibold text-foreground">{lgFoundCount}</span>
                      {' · '}
                      Em falta: <span className="font-semibold text-foreground">{lgMissingCount}</span>
                    </p>

                    {lgMissingCount > 0 && (
                      <div className="mt-3 space-y-2">
                        {(parseResult.debug?.lg_master_missing || []).map((item, idx) => (
                          <p key={`${item.location_id}-${idx}`} className="text-xs text-destructive">
                            {item.location_id} (warehouse {item.warehouse_code})
                          </p>
                        ))}
                        <IndustrialButton
                          variant="outline"
                          size="sm"
                          onClick={handleOpenMissingLgForm}
                        >
                          Adicionar Localização em falta
                        </IndustrialButton>
                      </div>
                    )}
                  </div>
                </div>
              </IndustrialCard>
            )}

            {/* No orders created */}
            {!hasCreatedOrders && (
              <IndustrialCard>
                <div className="text-center py-8">
                  <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
                    <XCircle className="w-8 h-8 text-destructive" />
                  </div>
                  <h3 className="text-xl font-bold text-foreground mb-2">
                    Nenhuma Encomenda Criada
                  </h3>
                  <p className="text-muted-foreground">
                    O ficheiro não continha encomendas válidas ou ocorreram erros de parsing.
                  </p>
                </div>
              </IndustrialCard>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <IndustrialButton
                variant="outline"
                size="lg"
                onClick={handleReset}
              >
                Importar Outro Ficheiro
              </IndustrialButton>
              {hasCreatedOrders && (
                <IndustrialButton
                  variant="primary"
                  size="lg"
                  onClick={() => navigate('/orders')}
                  icon={<FileText className="w-5 h-5" />}
                >
                  Ver Encomendas
                </IndustrialButton>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Help Section */}
      <div className="max-w-3xl mx-auto mt-8">
        <IndustrialCard>
          <h4 className="font-semibold text-foreground mb-3">Formatos Suportados</h4>
          <div className="grid md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="font-medium text-foreground">EDIFACT (ORDERS)</p>
              <p className="text-muted-foreground">
                Mensagens EDI standard (D96A, D01B). Segmentos UNH, BGM, NAD, LIN, QTY.
              </p>
            </div>
            <div>
              <p className="font-medium text-foreground">CSV / Texto</p>
              <p className="text-muted-foreground">
                NºEncomenda;CodCliente;CodArtigo;Qtd;Descrição;Unidade;DataEntrega
              </p>
            </div>
          </div>
        </IndustrialCard>
      </div>
    </MainLayout>
  );
}

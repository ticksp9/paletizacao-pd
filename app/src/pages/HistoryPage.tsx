import { useState, useEffect } from 'react';
import { History, FileText, Upload, Tag, Clock } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialCard } from '@/components/ui/IndustrialCard';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { pt } from 'date-fns/locale';

interface HistoryEntry {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  performed_by: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export default function HistoryPage() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    // Fetch from multiple sources to show activity
    const [ediFiles, orders] = await Promise.all([
      supabase.from('edi_files').select('id, filename, status, imported_at').order('imported_at', { ascending: false }).limit(20),
      supabase.from('orders').select('id, order_number, status, created_at, updated_at').order('updated_at', { ascending: false }).limit(20),
    ]);

    const historyItems: HistoryEntry[] = [];

    // Add EDI file imports
    ediFiles.data?.forEach((file: any) => {
      historyItems.push({
        id: `edi-${file.id}`,
        entity_type: 'edi_file',
        entity_id: file.id,
        action: 'Ficheiro EDI importado',
        performed_by: null,
        details: { filename: file.filename, status: file.status },
        created_at: file.imported_at,
      });
    });

    // Add order updates
    orders.data?.forEach((order: any) => {
      historyItems.push({
        id: `order-${order.id}`,
        entity_type: 'order',
        entity_id: order.id,
        action: `Encomenda ${order.status}`,
        performed_by: null,
        details: { order_number: order.order_number, status: order.status },
        created_at: order.updated_at || order.created_at,
      });
    });

    // Sort by date
    historyItems.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    setHistory(historyItems);
    setIsLoading(false);
  };

  const getIcon = (entityType: string) => {
    switch (entityType) {
      case 'edi_file': return Upload;
      case 'order': return FileText;
      case 'label': return Tag;
      default: return Clock;
    }
  };

  const getIconColor = (entityType: string) => {
    switch (entityType) {
      case 'edi_file': return 'bg-blue-100 text-blue-600';
      case 'order': return 'bg-orange-100 text-orange-600';
      case 'label': return 'bg-green-100 text-green-600';
      default: return 'bg-gray-100 text-gray-600';
    }
  };

  const filteredHistory = history.filter((entry) =>
    entry.action.toLowerCase().includes(searchTerm.toLowerCase()) ||
    JSON.stringify(entry.details).toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <MainLayout
      title="Histórico"
      subtitle="Registo de todas as operações"
    >
      {/* Search */}
      <div className="mb-6 max-w-md">
        <Input
          aria-label="Pesquisar no histórico"
          placeholder="Pesquisar no histórico..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="h-12"
        />
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-muted-foreground">A carregar...</div>
      ) : filteredHistory.length === 0 ? (
        <IndustrialCard>
          <div className="text-center py-12">
            <History className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">Nenhuma atividade registada</p>
            <p className="text-muted-foreground">
              As operações serão registadas aqui
            </p>
          </div>
        </IndustrialCard>
      ) : (
        <IndustrialCard>
          <div className="space-y-0">
            {filteredHistory.map((entry, index) => {
              const Icon = getIcon(entry.entity_type);
              return (
                <div
                  key={entry.id}
                  className={`flex items-start gap-4 py-4 ${
                    index !== filteredHistory.length - 1 ? 'border-b border-border' : ''
                  }`}
                >
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${getIconColor(entry.entity_type)}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground">{entry.action}</p>
                    {entry.details && (
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {String(entry.details.filename || entry.details.order_number || '')}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">
                      {format(new Date(entry.created_at), "dd MMM yyyy", { locale: pt })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(entry.created_at), "HH:mm", { locale: pt })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </IndustrialCard>
      )}
    </MainLayout>
  );
}

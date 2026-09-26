import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Search, ChevronRight, MapPin } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialCard } from '@/components/ui/IndustrialCard';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import type { Order, OrderStatus } from '@/types/database';
import { format } from 'date-fns';
import { pt } from 'date-fns/locale';

interface OrderWithLgCount extends Order {
  lg_count?: number;
  lg_codes?: string[];
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderWithLgCount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<OrderStatus | 'all'>('all');
  const navigate = useNavigate();

  useEffect(() => {
    fetchOrders();
  }, []);

  const fetchOrders = async () => {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && data) {
      const typedOrders = data as Order[];
      
      // Fetch LG codes from order_lines for each order
      const orderIds = typedOrders.map(o => o.id);
      const { data: lines } = await supabase
        .from('order_lines')
        .select('order_id, lg_code')
        .in('order_id', orderIds)
        .not('lg_code', 'is', null);

      const lgMap = new Map<string, Set<string>>();
      for (const line of (lines || [])) {
        if (!line.lg_code) continue;
        if (!lgMap.has(line.order_id)) lgMap.set(line.order_id, new Set());
        lgMap.get(line.order_id)!.add(line.lg_code);
      }

      setOrders(typedOrders.map(o => ({
        ...o,
        lg_count: lgMap.get(o.id)?.size || 0,
        lg_codes: Array.from(lgMap.get(o.id) || []),
      })));
    }
    setIsLoading(false);
  };

  const filteredOrders = orders.filter((order) => {
    const matchesSearch =
      order.order_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.customer_name?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || order.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const statusCounts = orders.reduce((acc, order) => {
    acc[order.status] = (acc[order.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <MainLayout
      title="Encomendas"
      subtitle={`${orders.length} encomendas no sistema`}
      actions={
        <IndustrialButton
          variant="primary"
          onClick={() => navigate('/import')}
          icon={<FileText className="w-5 h-5" />}
        >
          Nova Importação
        </IndustrialButton>
      }
    >
      {/* Status Summary */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {(['importado', 'validado', 'paletizado', 'etiquetas_geradas'] as OrderStatus[]).map((status) => (
          <IndustrialCard
            key={status}
            variant={statusFilter === status ? 'highlight' : 'interactive'}
            onClick={() => setStatusFilter(statusFilter === status ? 'all' : status)}
            className="cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <StatusBadge status={status} size="sm" />
              <span className="text-2xl font-bold text-foreground">
                {statusCounts[status] || 0}
              </span>
            </div>
          </IndustrialCard>
        ))}
      </div>

      {/* Search */}
      <div className="flex gap-4 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            aria-label="Pesquisar encomendas"
            placeholder="Pesquisar por número ou cliente..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-12"
          />
        </div>
      </div>

      {/* Orders Table */}
      <IndustrialCard>
        {isLoading ? (
          <div className="py-12 text-center text-muted-foreground">A carregar encomendas...</div>
        ) : filteredOrders.length === 0 ? (
          <div className="py-12 text-center">
            <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium text-foreground">Nenhuma encomenda encontrada</p>
            <p className="text-muted-foreground">
              {orders.length === 0 ? 'Importe um ficheiro EDI para começar' : 'Ajuste os filtros de pesquisa'}
            </p>
          </div>
        ) : (
          <table className="industrial-table">
            <thead>
              <tr>
                <th>Nº Encomenda</th>
                <th>Cliente</th>
                <th>Data Entrega</th>
                <th>Lojas (LG)</th>
                <th>Itens</th>
                <th>Paletes</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map((order) => (
                <tr
                  key={order.id}
                  onClick={() => navigate(`/orders/${order.id}`)}
                  className="cursor-pointer"
                >
                  <td className="font-semibold text-foreground">{order.order_number}</td>
                  <td>{order.customer_name || '-'}</td>
                  <td>
                    {order.delivery_date
                      ? format(new Date(order.delivery_date), 'dd MMM yyyy', { locale: pt })
                      : '-'}
                  </td>
                  <td>
                    {order.lg_count && order.lg_count > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="font-semibold">{order.lg_count}</span>
                        <span className="text-xs text-muted-foreground">
                          {order.lg_codes && order.lg_codes.length <= 3
                            ? order.lg_codes.join(', ')
                            : `${order.lg_codes?.slice(0, 2).join(', ')}…`}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td>{order.total_items}</td>
                  <td>{order.total_pallets}</td>
                  <td>
                    <StatusBadge status={order.status} size="sm" />
                  </td>
                  <td>
                    <ChevronRight className="w-5 h-5 text-muted-foreground" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </IndustrialCard>
    </MainLayout>
  );
}

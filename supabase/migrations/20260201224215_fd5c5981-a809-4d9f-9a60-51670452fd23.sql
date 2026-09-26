-- Enum para roles
CREATE TYPE public.app_role AS ENUM ('admin', 'operador');

-- Enum para estados de encomenda
CREATE TYPE public.order_status AS ENUM ('importado', 'validado', 'paletizado', 'etiquetas_geradas');

-- Tabela de perfis de utilizador
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabela de roles de utilizador
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL DEFAULT 'operador',
  UNIQUE (user_id, role)
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Função para verificar role
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- Função para obter role do utilizador
CREATE OR REPLACE FUNCTION public.get_user_role(_user_id UUID)
RETURNS app_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.user_roles WHERE user_id = _user_id LIMIT 1
$$;

-- RLS policies para profiles
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = user_id);
  
CREATE POLICY "Admins can view all profiles" ON public.profiles
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- RLS policies para user_roles
CREATE POLICY "Users can view own role" ON public.user_roles
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage roles" ON public.user_roles
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Master Data: Artigos
CREATE TABLE public.articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'UN',
  weight_kg DECIMAL(10,3),
  dimensions_cm TEXT,
  pieces_per_box INTEGER DEFAULT 1,
  boxes_per_pallet INTEGER DEFAULT 1,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Master Data: Embalagens
CREATE TABLE public.packaging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  type TEXT NOT NULL, -- 'caixa', 'palete', 'filme'
  dimensions_cm TEXT,
  max_weight_kg DECIMAL(10,3),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ficheiros EDI importados
CREATE TABLE public.edi_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_size INTEGER,
  status TEXT NOT NULL DEFAULT 'uploaded',
  imported_by UUID REFERENCES auth.users(id),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  error_message TEXT
);

-- Encomendas extraídas dos EDI
CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edi_file_id UUID REFERENCES public.edi_files(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  customer_code TEXT,
  customer_name TEXT,
  delivery_date DATE,
  status order_status NOT NULL DEFAULT 'importado',
  total_items INTEGER DEFAULT 0,
  total_pallets INTEGER DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Linhas de encomenda
CREATE TABLE public.order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  line_number INTEGER NOT NULL,
  article_id UUID REFERENCES public.articles(id),
  article_code TEXT NOT NULL,
  article_description TEXT,
  quantity INTEGER NOT NULL,
  unit TEXT DEFAULT 'UN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Planos de paletização
CREATE TABLE public.palletization_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  pallet_number INTEGER NOT NULL,
  packaging_id UUID REFERENCES public.packaging(id),
  total_boxes INTEGER DEFAULT 0,
  total_weight_kg DECIMAL(10,3),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Itens em cada palete
CREATE TABLE public.pallet_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  palletization_plan_id UUID REFERENCES public.palletization_plans(id) ON DELETE CASCADE NOT NULL,
  order_line_id UUID REFERENCES public.order_lines(id),
  quantity INTEGER NOT NULL,
  box_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Etiquetas geradas
CREATE TABLE public.labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE NOT NULL,
  palletization_plan_id UUID REFERENCES public.palletization_plans(id),
  label_type TEXT NOT NULL, -- 'pallet', 'box', 'product'
  label_data JSONB,
  pdf_storage_path TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by UUID REFERENCES auth.users(id)
);

-- Histórico de operações
CREATE TABLE public.operation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL, -- 'order', 'edi_file', 'label'
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  performed_by UUID REFERENCES auth.users(id),
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS em todas as tabelas
ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.packaging ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edi_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.palletization_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pallet_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_history ENABLE ROW LEVEL SECURITY;

-- Políticas RLS para utilizadores autenticados
CREATE POLICY "Authenticated users can view articles" ON public.articles
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage articles" ON public.articles
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Authenticated users can view packaging" ON public.packaging
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage packaging" ON public.packaging
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Authenticated users can view edi_files" ON public.edi_files
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert edi_files" ON public.edi_files
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can view orders" ON public.orders
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage orders" ON public.orders
  FOR ALL TO authenticated USING (true);

CREATE POLICY "Authenticated users can view order_lines" ON public.order_lines
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage order_lines" ON public.order_lines
  FOR ALL TO authenticated USING (true);

CREATE POLICY "Authenticated users can view palletization_plans" ON public.palletization_plans
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage palletization_plans" ON public.palletization_plans
  FOR ALL TO authenticated USING (true);

CREATE POLICY "Authenticated users can view pallet_items" ON public.pallet_items
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage pallet_items" ON public.pallet_items
  FOR ALL TO authenticated USING (true);

CREATE POLICY "Authenticated users can view labels" ON public.labels
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage labels" ON public.labels
  FOR ALL TO authenticated USING (true);

CREATE POLICY "Authenticated users can view operation_history" ON public.operation_history
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert operation_history" ON public.operation_history
  FOR INSERT TO authenticated WITH CHECK (true);

-- Trigger para atualizar updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_articles_updated_at BEFORE UPDATE ON public.articles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_packaging_updated_at BEFORE UPDATE ON public.packaging
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Trigger para criar perfil automaticamente no signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, name, email)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)), NEW.email);
  
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'operador');
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Storage bucket para ficheiros EDI
INSERT INTO storage.buckets (id, name, public) VALUES ('edi-files', 'edi-files', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('labels', 'labels', false);

-- Políticas de storage
CREATE POLICY "Authenticated users can upload EDI files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'edi-files');

CREATE POLICY "Authenticated users can view EDI files"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'edi-files');

CREATE POLICY "Authenticated users can upload labels"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'labels');

CREATE POLICY "Authenticated users can view labels"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'labels');
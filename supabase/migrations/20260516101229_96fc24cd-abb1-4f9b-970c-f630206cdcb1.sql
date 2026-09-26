
-- 1) Trigger: first user = admin, otherwise pendente
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _role app_role;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles) THEN
    _role := 'admin'::app_role;
  ELSE
    _role := 'pendente'::app_role;
  END IF;

  INSERT INTO public.profiles (user_id, name, email)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)), NEW.email);

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, _role);

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2) RLS — replace permissive policies with role-aware ones

-- edi_files
DROP POLICY IF EXISTS "Authenticated users can insert edi_files" ON public.edi_files;
DROP POLICY IF EXISTS "Authenticated users can view edi_files" ON public.edi_files;
CREATE POLICY "Operators and admins can insert edi_files"
  ON public.edi_files FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador'));
CREATE POLICY "Active roles can view edi_files"
  ON public.edi_files FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));

-- orders
DROP POLICY IF EXISTS "Authenticated users can manage orders" ON public.orders;
DROP POLICY IF EXISTS "Authenticated users can view orders" ON public.orders;
CREATE POLICY "Active roles can view orders"
  ON public.orders FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));
CREATE POLICY "Operators and admins can insert orders"
  ON public.orders FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador'));
CREATE POLICY "Active roles can update orders"
  ON public.orders FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));
CREATE POLICY "Operators and admins can delete orders"
  ON public.orders FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador'));

-- order_lines
DROP POLICY IF EXISTS "Authenticated users can manage order_lines" ON public.order_lines;
DROP POLICY IF EXISTS "Authenticated users can view order_lines" ON public.order_lines;
CREATE POLICY "Active roles can view order_lines"
  ON public.order_lines FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));
CREATE POLICY "Operators and admins can write order_lines"
  ON public.order_lines FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador'));

-- palletization_plans
DROP POLICY IF EXISTS "Authenticated users can manage palletization_plans" ON public.palletization_plans;
DROP POLICY IF EXISTS "Authenticated users can view palletization_plans" ON public.palletization_plans;
CREATE POLICY "Active roles can view palletization_plans"
  ON public.palletization_plans FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));
CREATE POLICY "Operators and admins can write palletization_plans"
  ON public.palletization_plans FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador'));

-- pallet_items
DROP POLICY IF EXISTS "Authenticated users can manage pallet_items" ON public.pallet_items;
DROP POLICY IF EXISTS "Authenticated users can view pallet_items" ON public.pallet_items;
CREATE POLICY "Active roles can view pallet_items"
  ON public.pallet_items FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));
CREATE POLICY "Operators and admins can write pallet_items"
  ON public.pallet_items FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador'));

-- labels
DROP POLICY IF EXISTS "Authenticated users can manage labels" ON public.labels;
DROP POLICY IF EXISTS "Authenticated users can view labels" ON public.labels;
CREATE POLICY "Active label roles can view labels"
  ON public.labels FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));
CREATE POLICY "Active label roles can write labels"
  ON public.labels FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));

-- label_jobs
DROP POLICY IF EXISTS "Authenticated users can manage label_jobs" ON public.label_jobs;
DROP POLICY IF EXISTS "Authenticated users can view label_jobs" ON public.label_jobs;
CREATE POLICY "Active label roles can view label_jobs"
  ON public.label_jobs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));
CREATE POLICY "Active label roles can write label_jobs"
  ON public.label_jobs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));

-- operation_history
DROP POLICY IF EXISTS "Authenticated users can insert operation_history" ON public.operation_history;
DROP POLICY IF EXISTS "Authenticated users can view operation_history" ON public.operation_history;
CREATE POLICY "Active roles can view operation_history"
  ON public.operation_history FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));
CREATE POLICY "Active roles can insert operation_history"
  ON public.operation_history FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));

-- Master data views (block pendente)
DROP POLICY IF EXISTS "Authenticated users can view articles" ON public.articles;
CREATE POLICY "Active roles can view articles"
  ON public.articles FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));

DROP POLICY IF EXISTS "Authenticated users can view packaging" ON public.packaging;
CREATE POLICY "Active roles can view packaging"
  ON public.packaging FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));

DROP POLICY IF EXISTS "Authenticated users can view delivery_sites" ON public.delivery_sites;
CREATE POLICY "Active roles can view delivery_sites"
  ON public.delivery_sites FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));

DROP POLICY IF EXISTS "Authenticated users can view pd_lg_locations" ON public.pd_lg_locations;
CREATE POLICY "Active roles can view pd_lg_locations"
  ON public.pd_lg_locations FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));

DROP POLICY IF EXISTS "Authenticated users can view pd internal article codes" ON public.pd_internal_article_codes;
CREATE POLICY "Active roles can view pd internal article codes"
  ON public.pd_internal_article_codes FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));

DROP POLICY IF EXISTS "Authenticated users can view warehouse addresses" ON public.warehouse_addresses;
CREATE POLICY "Active roles can view warehouse addresses"
  ON public.warehouse_addresses FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operador') OR public.has_role(auth.uid(), 'etiquetas'));

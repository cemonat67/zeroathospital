create table if not exists public.hsp_records (
  id integer primary key,
  year integer not null,
  hospital text not null,
  campus text,
  department text not null,
  energy_kwh bigint,
  water_m3 integer,
  waste_kg integer,
  medical_waste_kg integer,
  co2e_ton numeric(10,3),
  renewables_pct integer,
  recycling_pct integer,
  status text,
  created_at timestamptz default now()
);
create index if not exists idx_hsp_records_hyd on public.hsp_records (hospital, year, department);
create index if not exists idx_hsp_records_status on public.hsp_records (status);
create index if not exists idx_hsp_records_co2 on public.hsp_records (co2e_ton);

create table if not exists public.departments_energy (
  year integer not null,
  hospital text not null,
  department text not null,
  energy_kwh bigint not null,
  primary key (year, hospital, department)
);
create index if not exists idx_de_energy_hy on public.departments_energy (hospital, year);

create table if not exists public.departments_waste (
  year integer not null,
  hospital text not null,
  department text not null,
  waste_type text not null,
  kg integer not null,
  primary key (year, hospital, department, waste_type)
);
create index if not exists idx_de_waste_hy on public.departments_waste (hospital, year);

create table if not exists public.monthly_co2_trend (
  year integer not null,
  month integer not null check (month between 1 and 12),
  hospital text not null,
  co2e_ton numeric(10,3) not null,
  primary key (year, month, hospital)
);
create index if not exists idx_monthly_co2_hy on public.monthly_co2_trend (hospital, year);

create table if not exists public.taxonomy_izmir (
  campus text primary key,
  city text not null,
  eligible_revenue_mtl numeric(14,2) not null,
  aligned_revenue_pct numeric(5,2) not null,
  capex_aligned_pct numeric(5,2) not null,
  after_dnsh_pct numeric(5,2) not null,
  esrs_score integer not null
);

create view if not exists public.vw_hsp_dataset as
select year,
       hospital,
       department as dept,
       energy_kwh as energy,
       water_m3 as water,
       waste_kg as waste,
       medical_waste_kg as medw,
       co2e_ton as co2,
       renewables_pct as ren,
       recycling_pct as rec
from public.hsp_records;

alter table public.hsp_records enable row level security;
alter table public.departments_energy enable row level security;
alter table public.departments_waste enable row level security;
alter table public.monthly_co2_trend enable row level security;
alter table public.taxonomy_izmir enable row level security;

create policy if not exists p_select_authenticated_hsp_records on public.hsp_records for select to authenticated using (true);
create policy if not exists p_insert_service_role_hsp_records on public.hsp_records for insert to service_role with check (true);
create policy if not exists p_select_authenticated_de_energy on public.departments_energy for select to authenticated using (true);
create policy if not exists p_insert_service_role_de_energy on public.departments_energy for insert to service_role with check (true);
create policy if not exists p_select_authenticated_de_waste on public.departments_waste for select to authenticated using (true);
create policy if not exists p_insert_service_role_de_waste on public.departments_waste for insert to service_role with check (true);
create policy if not exists p_select_authenticated_monthly on public.monthly_co2_trend for select to authenticated using (true);
create policy if not exists p_insert_service_role_monthly on public.monthly_co2_trend for insert to service_role with check (true);
create policy if not exists p_select_authenticated_taxonomy on public.taxonomy_izmir for select to authenticated using (true);
create policy if not exists p_insert_service_role_taxonomy on public.taxonomy_izmir for insert to service_role with check (true);

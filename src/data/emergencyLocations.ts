export interface EmergencyLocation {
  id: string;
  type: 'war_shelter' | 'flood_zone' | 'medical' | 'water_point' | 'emergency_service';
  name: string;
  latitude: number;
  longitude: number;
  address: string;
  capacity?: number;
  phone?: string;
  notes?: string;
}

export const EMERGENCY_LOCATIONS: EmergencyLocation[] = [
  // War Shelters
  {
    id: '1',
    type: 'war_shelter',
    name: 'Downtown Underground Shelter',
    latitude: 44.8125,
    longitude: 20.4612,
    address: '123 Main Street',
    capacity: 500,
    phone: '+381 11 123 4567',
    notes: 'Equipped with emergency supplies',
  },
  {
    id: '2',
    type: 'war_shelter',
    name: 'Central Station Bunker',
    latitude: 44.8155,
    longitude: 20.4635,
    address: 'Railway Station Plaza',
    capacity: 300,
    phone: '+381 11 987 6543',
  },
  // Flood Zones / High Areas
  {
    id: '3',
    type: 'flood_zone',
    name: 'Terazije High Zone',
    latitude: 44.8165,
    longitude: 20.4565,
    address: 'Terazije Square',
    capacity: 1000,
    notes: 'Elevated area, safe from flooding',
  },
  {
    id: '4',
    type: 'flood_zone',
    name: 'Kalemegdan Fortress',
    latitude: 44.8270,
    longitude: 20.4490,
    address: 'Kalemegdan Park',
    capacity: 2000,
    notes: 'Historic fortress on high ground',
  },
  // Medical Facilities
  {
    id: '5',
    type: 'medical',
    name: 'Emergency Hospital',
    latitude: 44.8195,
    longitude: 20.4580,
    address: '456 Hospital Avenue',
    phone: '192',
    notes: '24/7 Emergency services',
  },
  {
    id: '6',
    type: 'medical',
    name: 'Red Cross Center',
    latitude: 44.8140,
    longitude: 20.4620,
    address: '789 Humanitarian Street',
    phone: '+381 11 222 3333',
  },
  // Water Distribution Points
  {
    id: '7',
    type: 'water_point',
    name: 'Public Water Station - North',
    latitude: 44.8220,
    longitude: 20.4700,
    address: 'Voždovac District',
  },
  {
    id: '8',
    type: 'water_point',
    name: 'Public Water Station - Center',
    latitude: 44.8150,
    longitude: 20.4550,
    address: 'City Center',
  },
  // Emergency Services
  {
    id: '9',
    type: 'emergency_service',
    name: 'Fire Department Station 1',
    latitude: 44.8180,
    longitude: 20.4650,
    address: '321 Fire Lane',
    phone: '193',
  },
  {
    id: '10',
    type: 'emergency_service',
    name: 'Police Headquarters',
    latitude: 44.8145,
    longitude: 20.4590,
    address: '555 Security Avenue',
    phone: '192',
  },
];

// Helper to get marker color based on type
export const getMarkerColor = (type: EmergencyLocation['type']): string => {
  const colors = {
    war_shelter: '#EF4444',           // Red
    flood_zone: '#F59E0B',            // Amber
    medical: '#10B981',               // Green
    water_point: '#3B82F6',           // Blue
    emergency_service: '#8B5CF6',     // Purple
  };
  return colors[type];
};

// Helper to get marker icon emoji
export const getMarkerIcon = (type: EmergencyLocation['type']): string => {
  const icons = {
    war_shelter: '🛡️',
    flood_zone: '⛰️',
    medical: '🏥',
    water_point: '💧',
    emergency_service: '🚨',
  };
  return icons[type];
};

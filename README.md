# Safr
Safr Disaster Assistant – An Offline AI-Powered Mobile Application for Emergency Communication and Guidance

## Features

### Offline Map with Real POI Data
- Offline-first map powered by MapLibre GL and locally stored `.mbtiles` tiles for Romania
- Real-time POI data (hospitals, pharmacies, fire stations, police stations) fetched from Overpass API with 24h AsyncStorage cache
- Filter menu to toggle POI categories on/off
- GPS-based user location tracking with distance and ETA calculations

### External Navigation
- One-tap navigation to any POI via Google Maps, Waze, or Apple Maps
- Haversine-based distance calculation and travel time estimates (driving/walking)

### Disaster Alert System
- Firebase Firestore-backed real-time alert creation and distribution
- Admin mode with authentication (long-press on map to create geo-located alerts)
- Alert parameters: type (earthquake, flood, fire, storm, chemical), severity, radius, message, expiration
- Alerts displayed as real-radius polygons on the map with severity-based coloring
- Active alerts list modal with details and admin delete capability
- Real-time subscription for instant alert updates across all users

### Emergency Guides
- Categorized emergency guides: Natural Disasters, Medical Emergencies, Personal Safety
- Step-by-step instructions with expandable sections

### AI-Powered Medical Assistant
- Dual-model RAG architecture for offline emergency medical first-aid guidance
- On-device LLM with automatic download and caching

### Admin System
- Admin authentication with session management
- Admin login accessible from HomeScreen
- Visual "Admin Mode Active" indicator

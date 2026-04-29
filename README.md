# SWARM System

SWARM is a full-stack monitoring and control system for an Autonomous Surface Vessel (ASV). It provides real-time telemetry visualization, mapping, and limited control capabilities through a frontend interface connected to a backend API that communicates with onboard vessel systems.

---

## System Architecture

SWARM is split into two main components:

- **Frontend (Client App)**  
  A real-time UI for monitoring and interacting with the ASV.

- **Backend (API Server)**  
  Handles data collection, processing, and communication with the ASV hardware/sensors, then streams data to the frontend.

The frontend does not communicate directly with the vessel — all data flows through the backend.

---

## Features

### Live Monitoring

Displays real-time operational data from the ASV:

- Battery status  
- Bin capacity  
- Latitude & longitude  
- Speed  
- Current mission  

Used for quick situational awareness of vessel state.

---

### Map View

Visualizes the ASV’s location using GPS data:

- Real-time position tracking  
- Movement visualization on map  

Helps understand vessel trajectory and current geographic context.

---

### Control Panel

Provides system-level insights and limited control features:

- Speed monitoring  
- Coordinates (latitude & longitude)  
- Orientation (MPU sensor data)  
- System logs  

Includes a **manual mode toggle**, enabling direct control of the ASV when permitted.

---

## Backend Responsibilities

The backend is responsible for:

- Collecting telemetry from the ASV (GPS, MPU, battery, etc.)
- Processing and normalizing sensor data
- Exposing API endpoints for the frontend
- Streaming real-time updates (e.g. WebSocket or polling)
- Handling manual control commands from the frontend

---

## Purpose

SWARM is designed as a lightweight ground control and monitoring interface for ASV operations, focusing on:

- Real-time system visibility  
- Geographic tracking and visualization  
- Safe manual override when required  

---

## Notes

- System accuracy depends on onboard sensors (GPS, MPU, power monitoring, etc.)
- Backend is required for all live data functionality
- Frontend is not functional without a running API server

---

## Future Improvements

- Route history / path replay on map  
- Waypoints and mission planning  
- Smarter alert system (battery, drift, signal loss)  
- Role-based control access (operator vs observer)  
- Improved real-time streaming (WebSockets optimization)# S.W.A.R.M

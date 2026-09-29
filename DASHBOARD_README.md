> **Frozen.** This legacy Flask dashboard (port 8091) is kept only for kiosks already
> pointed at it (the Kuwait skids) and runs only while `local_dashboard_enabled` is on.
> No new features: the HMI screen is the widget in `widget/`. See README.md
> "Legacy dashboard (frozen)" for the retirement plan.

# SIA Local Control Dashboard

A real-time web dashboard for monitoring and controlling SIA Local Control systems, featuring pump control, solar control, and tank monitoring.

## Features

### Pump Control
- **Target Rate**: Set and monitor target flow rate (L/min)
- **Flow Rate**: Real-time flow rate monitoring (L/min)
- **Pump State**: Control pump states (standby, auto, calibration)

### Solar Control
- **Battery Voltage**: Monitor battery voltage levels (V)
- **Battery Percentage**: Visual battery level with progress bar (%)
- **Array Voltage**: Solar array voltage monitoring (V)

### Tank Control
- **Tank Level**: Monitor tank levels in both mm and percentage
- **System Status**: Overall system status indicator

## Technical Details

### Architecture
- **Backend**: Flask web server with WebSocket support
- **Frontend**: HTML5, CSS3, JavaScript with Socket.IO client
- **Real-time Communication**: WebSocket connections for live data updates
- **Port**: 8091 (configurable)

### Components

1. **`dashboard.py`**: Core dashboard server and interface classes
   - `SiaDashboard`: Main Flask server with WebSocket support
   - `DashboardInterface`: Integration interface for Application class
   - `DashboardData`: Data container with validation

2. **`templates/dashboard.html`**: Main dashboard UI template

3. **`static/css/dashboard.css`**: Modern, responsive styling

4. **`static/js/dashboard.js`**: Client-side JavaScript for real-time updates

## Usage

### Integration with Application
The dashboard is automatically integrated into the `SiaLocalControlUiApplication` class:

```python
# Dashboard starts automatically on port 8091
# Data is updated via the main application loop
```

### Manual Testing
Run the test script to verify dashboard functionality:

```bash
python test_dashboard.py
```

Then open your browser to: `http://127.0.0.1:8091`

### API Endpoints

- `GET /`: Main dashboard interface
- `GET /api/data`: REST API for current data (JSON)
- `GET /api/health`: Health check endpoint

### WebSocket Events

**Client to Server:**
- `request_data`: Request current data
- `set_pump_state`: Change pump state

**Server to Client:**
- `data_update`: Broadcast data updates
- `heartbeat`: Periodic connection heartbeat
- `error`: Error notifications

## Dependencies

- Flask >= 3.0.0
- Flask-SocketIO >= 5.3.0
- python-socketio >= 5.9.0

## Configuration

The dashboard can be configured in the Application class:

```python
# In application.py
self.dashboard = SiaDashboard(
    host="0.0.0.0",  # Bind to all interfaces
    port=8091,       # Dashboard port
    debug=False      # Debug mode
)
```

## Browser Compatibility

- Modern browsers with WebSocket support
- Chrome 16+, Firefox 11+, Safari 7+, Edge 12+
- Mobile responsive design

## Security Notes

- Dashboard binds to all interfaces (0.0.0.0) for accessibility
- No authentication implemented (add as needed for production)
- CORS enabled for development
- Consider adding HTTPS in production environments

## Troubleshooting

1. **Port already in use**: Change port in dashboard configuration
2. **WebSocket connection failed**: Check firewall settings
3. **No data updates**: Verify Application class integration
4. **Styling issues**: Clear browser cache

## Future Enhancements

- User authentication and authorization
- Historical data logging and charts
- Alert/notification system
- Mobile app support
- Multi-language support
- Customizable dashboard layouts

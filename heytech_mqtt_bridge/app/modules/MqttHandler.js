const mqtt = require('mqtt');
const fs = require('fs');
const EventEmitter = require('events');

class MqttHandler extends EventEmitter {
  constructor(options) {
    super();
    this.mqttClient = null;
    this.config = options.config;
    this.eventHandler = options.handler;
    this.eventHandler.setCommunicator(this);
    this.log = {};
    this.log.debug = function (text) {}; //console.log;
    this.log.info = function (text) { console.info(new Date() + " INFO: " +text); };
    this.log.warn = function (text) { console.log(new Date() + " WARN: " + text); };
    this.log.error = function (text) { console.log(new Date() + " ERROR: " + text); }; //function (text) { console.error(new Date() + text); };


    this.on('message',this.publishMessage);
    //console.log(options);
  }

  publishMessage(suffix,message) {
    const topic = this.config.state_topic_root + '/' + suffix;
    try {
      if (this.mqttClient) this.mqttClient.publish(topic, message);
    } catch (error) {
      this.log.error('MQTT publish failed: ' + error.message);
    }
  }

  processMessage(topic,message) {
    if (message.length > 4096) { this.log.warn('Oversized MQTT command ignored'); return; }
    const rolloId = topic.split('/').pop();
    const plain = message.toString();
    let command;
    try { command = JSON.parse(plain); } catch (_) { command = plain; }
    // Preserve plain commands and JSON action objects; never retry a failed handler.
    if (typeof command !== 'string' && (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.action !== 'string')) return;
    try {
      this.eventHandler.emit('message', rolloId, command);
    } catch (error) {
      this.log.error('Command handler failed: ' + error.message);
    }
  }

  connect() {
    if (this.mqttClient !== null) return;
    let proto = 'mqtt://';
    var opts = {};
    // Connect mqtt with credentials (in case of needed, otherwise we can omit 2nd param)
    if ((this.config.cafile !== undefined) && (this.config.cafile.length > 0 )) {
      opts.ca = [  fs.readFileSync(this.config.cafile) ];
      proto = 'mqtts://';
    }
    if ((this.config.user !== undefined) && (this.config.user.length > 0)){
      if (this.config.pass === undefined) this.config.pass = "";
      opts.username = this.config.user;
      opts.password = this.config.pass;
    }

    if (( this.config.port !== undefined ) && (this.config.port > 0)) {
      opts.port = this.config.port;
    }

    this.mqttClient = mqtt.connect(proto + this.config.host, opts);


    // Mqtt error callback
    this.mqttClient.on('error', (err) => {
      this.log.error("MqttClient: "+err);
    });

    // Connection callback
    this.mqttClient.on('connect', () => {
      this.log.info('mqtt client connected');
      this.sendMessage("ONLINE");
    });

    // mqtt subscriptions
    this.log.info("subscribing to "+this.config.control_topic_root+'/#');
    this.mqttClient.subscribe(this.config.control_topic_root + '/#', {qos: 0});

    this.mqttClient.on('message', this.processMessage.bind(this));

    this.mqttClient.on('close', () => {
      console.log(`mqtt client disconnected`);
    });
  }

  // Sends a mqtt message to topic: mytopic
  sendMessage(message) {
    try {
      if (this.mqttClient) this.mqttClient.publish(this.config.state_topic_root, message);
    } catch (error) {
      this.log.error('MQTT publish failed: ' + error.message);
    }
  }



}

module.exports = MqttHandler;

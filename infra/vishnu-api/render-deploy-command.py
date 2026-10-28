#!/usr/bin/env python3
"""Print a complete dev SAM command; never execute it or read secret values."""
import argparse
from pathlib import Path
import shlex
import yaml

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('stage', choices=['bootstrap-dev', 'routing-dev-blue', 'routing-dev-green', 'dev', 'dev-green'])
parser.add_argument('overrides', nargs='*', metavar='Key=Value')
args = parser.parse_args()
config_file = Path(__file__).resolve().with_name('samconfig.yaml')
params = yaml.safe_load(config_file.read_text())[args.stage]['deploy']['parameters']
values = dict(pair.split('=', 1) for pair in params['parameter_overrides'])
required = set() if args.stage == 'bootstrap-dev' else {'ListenerRulePriorityBase'} if args.stage.startswith('routing-') else {'ImageArn', 'BuildRevision'}
# MQ receiver wiring (gh_536 d3/d4); optional, and the templates default it off.
optional = (
    {'MqNetworkEnabled', 'DbHostPostgresPort', 'VishnuDatabaseUrlSecretArn'} if args.stage == 'bootstrap-dev'
    else {'VishnuMqEnabled', 'VishnuDatabaseUrlSecretArn', 'EventStatsDeployment', 'EventStatsBroker', 'EventStatsVhost'}
    if args.stage in ['dev', 'dev-green'] else set()
)
if args.stage == 'dev-green':
    optional.add('DesiredCount')  # only for an explicit cutover; green otherwise stays at 0
for pair in args.overrides:
    if '=' not in pair:
        parser.error('Overrides must be Key=Value')
    key, value = pair.split('=', 1)
    if key not in required | optional or not value:
        parser.error(f'Only these nonempty overrides are accepted: {sorted(required | optional)}')
    values[key] = value
missing = required - values.keys()
if missing:
    parser.error(f'Missing: {sorted(missing)}')
if args.stage.startswith('routing-'):
    try:
        priority = int(values['ListenerRulePriorityBase'])
    except ValueError:
        parser.error('Priority must be numeric')
    if not 1 <= priority <= 3999:
        parser.error('Priority must be in the preview range 1–3999; check the live listener before choosing')
if args.stage in ['dev', 'dev-green'] and not values['ImageArn'].startswith('396913734878.dkr.ecr.us-west-2.amazonaws.com/soa/vishnu-api:'):
    parser.error('Image must be an immutable tag in the dev Vishnu ECR repository')
command = ['sam', 'deploy', '--profile', 'saga-infra-dev', '--region', params['region'],
           '--template-file', params['template_file'], '--stack-name', params['stack_name'],
           '--capabilities', *params['capabilities'], '--confirm-changeset',
           '--parameter-overrides', *(f'{k}={v}' for k, v in values.items())]
print('# Run from the repository root after reviewing the change set:')
print(shlex.join(command))

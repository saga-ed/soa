import PropTypes from 'prop-types';

export function Code({ children, className, }) {
    return <code className={className}>{children}</code>;
}

Code.propTypes = {
    children: PropTypes.node,
    className: PropTypes.string,
};
